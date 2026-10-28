import pg from "pg";
import { dropDatabase, withAdminClient, withDatabase } from "../db/databases.js";
import { runMigrations } from "../db/migrate.js";
import { addDays, AHEAD_DAYS, analyzeParent, BEHIND_DAYS, createDailyPartitions, dbToday } from "../db/partitions.js";
import { createPool } from "../db/pool.js";
import { runRollup } from "../rollup.js";

// 측정 템플릿(DESIGN 6.8 "측정 템플릿", 10장 59). 개발 DB는 계속 바뀌므로(집계 작업, 관리 작업, 손으로 한 ANALYZE)
// 측정 전용 템플릿을 한 번 만들고, 회차마다 그것을 복제한다. 기본 이름은 여기서 정한다.
export const TEMPLATE_DATABASE = "event_analytics_load_template";
export const LOAD_DATABASE = "event_analytics_load";
// load/results(gitignore). 템플릿을 만든 기록과 측정 결과를 둔다.
export const RESULTS_DIR = new URL("../../../../load/results/", import.meta.url);
export const TEMPLATE_INFO_FILE = new URL("load-template.json", RESULTS_DIR);

// 명령줄로 받는 템플릿 이름(5,000만 건 등). 만들 때 그 이름의 DB를 먼저 지우므로, 측정용 접두어가 붙은 이름만 받는다
// (개발 DB나 다른 프로젝트의 DB를 지우지 않게). 회차의 복제(event_analytics_load)와 겹치지 않게 접두어 뒤에 이름이 있어야 한다.
const TEMPLATE_NAME = /^event_analytics_load_[a-z0-9_]+$/;
export function checkTemplateName(name: string) {
  if (!TEMPLATE_NAME.test(name)) throw new Error(`템플릿 이름은 event_analytics_load_로 시작하고 소문자·숫자·_만 씁니다: ${name}`);
  return name;
}
// 원본은 복제만 하므로 지우지 않는다. SQL에 이름을 그대로 넣으므로 식별자 모양만 받는다.
export function checkSourceName(name: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`원본 DB 이름은 소문자·숫자·_만 씁니다: ${name}`);
  return name;
}
// 템플릿마다의 기록 파일. 기본 템플릿은 예전 이름(load-template.json)을 그대로 쓴다.
export const templateInfoFile = (name: string) =>
  name === TEMPLATE_DATABASE ? TEMPLATE_INFO_FILE : new URL(`load-template.${name}.json`, RESULTS_DIR);

// 복제는 원본 DB에 연결이 하나도 없어야 한다(개발 API를 끈다). FILE_COPY는 앞뒤로 체크포인트를 하고 WAL을 적게 쓴다.
// 기본값 WAL_LOG는 DB 전체를 WAL로 써서 측정 앞부분에 체크포인트가 겹친다(설계 리뷰).
async function cloneDatabase(ownerUrl: string, source: string, target: string) {
  // 원본과 대상이 같으면 원본을 지운 뒤 복제가 실패한다(소유자 주소가 템플릿을 가리킬 때 등)
  if (source === target) throw new Error(`원본과 대상이 같습니다(${source})`);
  await withAdminClient(ownerUrl, async (client) => {
    await dropDatabase(client, target);
    try {
      await client.query(`CREATE DATABASE ${target} TEMPLATE ${source} STRATEGY FILE_COPY`);
    } catch (err) {
      if ((err as { code?: string }).code === "55006") {
        throw new Error(`${source}에 연결이 남아 있어 복제하지 못했습니다. 그 DB를 쓰는 API·도구를 끄고 다시 하세요`, { cause: err });
      }
      throw err;
    }
  });
  return withDatabase(ownerUrl, target);
}

// 일반 표(파티션의 잎 포함)의 autovacuum을 끈다. 사용자가 서버의 autovacuum을 고쳐도 측정 중에 돌지 않게(회차 조건이 같게).
// 부모(파티션 표)는 autovacuum이 처리하지 않고 이 설정도 받지 않는다. 새로 만든 파티션은 LIKE로도 이 설정을 이어받지 않아 따로 건다.
async function disableAutovacuum(client: pg.ClientBase, names?: string[]) {
  const { rows } = await client.query<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and ($1::text[] is null or c.relname = any($1))`,
    [names ?? null],
  );
  for (const { name } of rows) await client.query(`alter table "${name}" set (autovacuum_enabled = false)`);
}

// 템플릿을 만든다: 원본 복제 → 집계 작업을 끝까지 → 잎 표마다 VACUUM (FREEZE, ANALYZE) → 부모 통계 지움 → autovacuum 끔.
// 소유자 주소로 돈다(ANALYZE·VACUUM은 소유자만 한다, 10장 57). 운영 서버에서 파티션 부모(events)는 자동으로 분석되지 않는다.
// 그래서 DB 전체 VACUUM(부모까지 분석) 대신 잎만 이름으로 하고, 원본의 부모 통계(개발 DB는 손으로 ANALYZE했다)는 지운다.
// 그래야 후보 "부모 표의 통계"를 ANALYZE ONLY events 전후로 볼 수 있다(코드 리뷰).
export async function buildLoadTemplate(ownerUrl: string, { source, template = TEMPLATE_DATABASE }: { source: string; template?: string }) {
  const url = await cloneDatabase(ownerUrl, source, template);
  const pool = createPool({ connectionString: url, max: 1, application_name: "event-analytics-load-template" });
  try {
    // 집계 작업이 한 실행에 다 못 하면(조각 한도) 다시 부른다. 지금 시간(정시 뒤)의 더러운 시간은 집계가 가져가지 않으므로 세지 않는다.
    let left = 0;
    for (let round = 0; round < 20; round++) {
      await runRollup(pool);
      const { rows } = await pool.query<{ left: number }>(
        "select count(*)::int as left from dirty_hours where hour < date_trunc('hour', now(), 'UTC')",
      );
      left = rows[0]!.left;
      if (left === 0) break;
    }
    if (left > 0) throw new Error(`집계 작업을 스무 번 돌려도 지난 시간의 더러운 시간이 ${left}개 남았습니다`);
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ name: string }>(
        `select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname in ('public', 'drizzle') and c.relkind = 'r' order by 1`,
      );
      await client.query(`vacuum (freeze, analyze) ${rows.map((r) => r.name).join(", ")}`);
      // PG18의 통계 지우기(표에 MAINTAIN 권한, 소유자는 가진다). 부모의 통계는 상속(inherited) 통계다.
      await client.query(
        `select pg_clear_attribute_stats('public', 'events', a.attname::text, true)
           from pg_attribute a where a.attrelid = 'events'::regclass and a.attnum > 0 and not a.attisdropped`,
      );
      await client.query("select pg_clear_relation_stats('public', 'events')");
      await disableAutovacuum(client);
    } finally {
      client.release();
    }
    return await loadDatabaseState(url);
  } finally {
    await pool.end();
  }
}

// 회차 한 번의 DB를 템플릿에서 새로 만들고, 관리 작업 가운데 만들기와 부모 표의 통계를 돈다(관리 작업과 같은 범위: 지난 7일 ~ 앞으로 7일).
// 지난 7일이 없으면 늦은 이벤트가 partition_missing으로 503이 된다(코드 리뷰). 떼기는 돌지 않는다: 날이 지나면 보관 기간 밖
// 날이 생기지만, 회차마다 파티션 수와 행 수를 남겨 같은 일을 했는지 본다.
// 부모 표의 통계(10장 62): 템플릿은 부모를 분석하지 않은 채 두고(고치기 전의 운영), 회차마다 관리 작업처럼 분석한다(고친 뒤의 운영).
// 템플릿보다 뒤의 마이그레이션(고침의 확장 통계 등)은 복제에 먼저 적용한다. 그래야 템플릿을 다시 만들지 않고 전후를 번갈아 잴 수 있다.
export async function cloneLoadDatabase(ownerUrl: string, { template = TEMPLATE_DATABASE, target = LOAD_DATABASE } = {}) {
  const url = await cloneDatabase(ownerUrl, template, target);
  await runMigrations(url);
  const client = new pg.Client({ connectionString: url, application_name: "event-analytics-load-runner" });
  await client.connect();
  try {
    const today = await dbToday(client);
    const created = await createDailyPartitions(client, addDays(today, -BEHIND_DAYS), addDays(today, AHEAD_DAYS));
    if (created.length > 0) await disableAutovacuum(client, created);
    await analyzeParent(client);
  } finally {
    await client.end();
  }
  return url;
}

// 회차 조건으로 남기는 DB의 상태(DESIGN 6.8). 앱 role로도 읽힌다. 누적 통계(마지막 청소·분석 시각)는 복제되지 않으므로,
// 복제해도 남는 신호(가시성 맵, 동결 나이, 통계가 있는지)를 쓴다.
export async function loadDatabaseState(url: string) {
  const client = new pg.Client({ connectionString: url, application_name: "event-analytics-load-runner" });
  await client.connect();
  try {
    const one = async <T>(sql: string) => (await client.query<T & pg.QueryResultRow>(sql)).rows[0]!;
    const rollup = await one<{ dirty_hours: number; watermark: Date | null }>(
      "select (select count(*)::int from dirty_hours) as dirty_hours, (select watermark from rollup_state) as watermark",
    );
    // 아직 분석하지 않은 파티션의 reltuples는 -1이라 0으로 센다
    const events = await one<{ partitions: number; rows: number; first_day: string | null; last_day: string | null }>(
      `select count(*)::int as partitions, coalesce(sum(greatest(c.reltuples, 0)), 0)::bigint::float8 as rows,
              min(substr(c.relname, 9)) as first_day, max(substr(c.relname, 9)) as last_day
         from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'events'::regclass`,
    );
    // 부모(events)의 통계가 있는지: 자동으로 분석되지 않아 템플릿에는 없고(고치기 전의 운영), 고친 뒤에는 복제가 관리 작업처럼 분석한다(10장 62).
    // 회차마다 남겨, 전후 회차를 맞는 코드로 돌렸는지 본다.
    const parent = await one<{ stats: number; ext: number }>(
      `select (select count(*)::int from pg_stats where schemaname = 'public' and tablename = 'events') as stats,
              (select count(*)::int from pg_statistic_ext where stxrelid = 'events'::regclass) as ext`,
    );
    // public의 일반 표마다 VM·죽은 행·통계·autovacuum. 파티션은 하나로 묶어 가장 덜 된 값을 쓴다.
    const tables = (
      await client.query(
        `select case when c.relname like 'events_p%' then 'events_*' else c.relname end as name,
                count(*)::int as tables,
                min(case when c.relpages > 0 then c.relallvisible::float8 / c.relpages end) as visible_min,
                sum(coalesce(s.n_dead_tup, 0))::bigint::float8 as dead,
                count(*) filter (where exists (select 1 from pg_stats p where p.schemaname = 'public' and p.tablename = c.relname))::int as with_stats,
                max(age(c.relfrozenxid))::int as frozen_age_max,
                bool_and(coalesce(c.reloptions @> array['autovacuum_enabled=false'], false)) as autovacuum_off
           from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_stat_user_tables s on s.relid = c.oid
          where n.nspname = 'public' and c.relkind = 'r'
          group by 1 order by 1`,
      )
    ).rows;
    const settings = (
      await client.query<{ name: string; setting: string }>(
        `select name, setting from pg_settings
          where name in ('data_checksums', 'io_method', 'io_workers', 'max_parallel_workers', 'max_parallel_workers_per_gather',
                         'max_worker_processes', 'work_mem', 'hash_mem_multiplier', 'jit', 'shared_buffers', 'track_io_timing')
          order by name`,
      )
    ).rows;
    const jit = await one<{ available: boolean }>("select pg_jit_available() as available");
    return {
      at: new Date().toISOString(),
      dirtyHours: rollup.dirty_hours,
      watermark: rollup.watermark?.toISOString() ?? null,
      partitions: events.partitions,
      eventRows: events.rows,
      days: { first: events.first_day, last: events.last_day },
      parentStats: parent.stats,
      // 부모의 확장 통계 객체 수(마이그레이션 0004가 둘을 만든다). 값이 찼는지는 pg_stats_ext로 보는데, 그 뷰는 표의 소유자에게만
      // 행을 보여 준다(앱 role로 읽으면 늘 0). 그래서 객체가 있는지만 남기고, 값이 차는 것은 관리 작업 테스트가 지킨다.
      parentExtStats: parent.ext,
      tables,
      settings: { ...Object.fromEntries(settings.map((s) => [s.name, s.setting])), jitAvailable: String(jit.available) },
    };
  } finally {
    await client.end();
  }
}

export type LoadDatabaseState = Awaited<ReturnType<typeof loadDatabaseState>>;
