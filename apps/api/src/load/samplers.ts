import { appendFileSync } from "node:fs";
import pg from "pg";

// DB 쪽 표본(DESIGN 6.8 "증거"). 실행기만 쓴다. seat-booking의 것을 이 API의 앱 이름 셋과 병렬 작업자에 맞췄다.

type ActivityRow = { app: string; worker: boolean; state: string | null; wait_type: string; wait_event: string; count: number | string };

// 0.2초마다 이 DB의 API 연결을 앱 이름(api·reports·rollup)·상태·기다리는 것별로 세고, 1초마다 평균을 한 줄로 쓴다.
// 병렬 작업자는 리더(leader_pid)의 앱 이름으로 묶어 따로 센다(리더만 보면 IPC 대기만 보인다, 설계 리뷰).
// 앱 role은 다른 role과 백그라운드 프로세스(IO 작업자, autovacuum)를 볼 수 없다. 표본마다 따로 읽는다(한 트랜잭션 안의 통계는 캐시된다).
const ACTIVITY = `
  select coalesce(l.application_name, a.application_name) as app, a.leader_pid is not null and a.leader_pid <> a.pid as worker,
         a.state, coalesce(a.wait_event_type, '') as wait_type, coalesce(a.wait_event, '') as wait_event, count(*)
    from pg_stat_activity a
    left join pg_stat_activity l on l.pid = a.leader_pid and a.leader_pid <> a.pid
   where a.datname = current_database() and a.pid <> pg_backend_pid()
     and coalesce(l.application_name, a.application_name) like 'event-analytics-%'
     and coalesce(l.application_name, a.application_name) <> 'event-analytics-load-runner'
   group by 1, 2, 3, 4, 5`;

export async function startActivitySampler(url: string, outFile: string, intervalMs = 200) {
  const client = new pg.Client({ connectionString: url, application_name: "event-analytics-load-runner" });
  await client.connect();
  let samples: ActivityRow[][] = [];
  let busy = false;
  const sampleTimer = setInterval(() => {
    if (busy) return;
    busy = true;
    client
      .query<ActivityRow>(ACTIVITY)
      .then(({ rows }) => samples.push(rows))
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, intervalMs);

  function flush() {
    const n = samples.length;
    if (n === 0) return;
    // 키: "앱 [작업자] 상태 대기". 대기가 없고 active면 DB CPU다.
    const counts: Record<string, number> = {};
    for (const rows of samples) {
      for (const row of rows) {
        const app = row.app.replace("event-analytics-", "");
        const wait = row.wait_type ? `${row.wait_type}:${row.wait_event}` : "-";
        const key = `${app}${row.worker ? " 작업자" : ""} ${row.state ?? "unknown"} ${wait}`;
        counts[key] = (counts[key] ?? 0) + Number(row.count);
      }
    }
    const average = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round((v / n) * 100) / 100]));
    appendFileSync(outFile, `${JSON.stringify({ at: new Date().toISOString(), samples: n, byKey: average })}\n`);
    samples = [];
  }
  const flushTimer = setInterval(flush, 1000);

  return {
    async stop() {
      clearInterval(sampleTimer);
      clearInterval(flushTimer);
      flush();
      await client.end();
    },
  };
}

// 측정 앞뒤로 찍는 누적 통계. 뒤에서 앞을 빼서 본다. 파티션은 events_*로 묶는다.
// 다른 DB의 xact_commit은 같은 서버를 다른 일이 썼는지 본다(그 회차는 무효, DESIGN 6.8 "무효 조건"). DB마다 찍는다:
// 합으로 보면 측정 중에 지워진 DB(테스트의 정리)의 커밋이 빠져 차이가 음수가 되고 검사를 지나친다(코드 리뷰).
// 이 PC는 autovacuum이 사용자 표를 처리하지 않아 쉴 때 다른 DB의 커밋이 0이다. 서버가 고쳐지면 autovacuum 작업자의 트랜잭션도 여기 잡히므로
// 그때는 클라이언트 백엔드만 세는 값(sessions, active_time)으로 바꾼다.
export async function snapshotStats(url: string) {
  const client = new pg.Client({ connectionString: url, application_name: "event-analytics-load-runner" });
  await client.connect();
  try {
    const group = (column: string) => `case when ${column} like 'events_p%' then 'events_*' else ${column} end`;
    const tables = await client.query(
      `select ${group("s.relname")} as name,
              sum(s.seq_scan)::float8 as seq_scan, sum(s.seq_tup_read)::float8 as seq_tup_read, sum(coalesce(s.idx_scan, 0))::float8 as idx_scan,
              sum(s.n_tup_ins)::float8 as n_tup_ins, sum(s.n_tup_del)::float8 as n_tup_del, sum(s.n_dead_tup)::float8 as n_dead_tup,
              sum(s.vacuum_count + s.autovacuum_count)::float8 as vacuums, sum(s.analyze_count + s.autoanalyze_count)::float8 as analyzes,
              sum(io.heap_blks_read)::float8 as heap_blks_read, sum(io.heap_blks_hit)::float8 as heap_blks_hit,
              sum(coalesce(io.idx_blks_read, 0))::float8 as idx_blks_read, sum(coalesce(io.idx_blks_hit, 0))::float8 as idx_blks_hit
         from pg_stat_user_tables s join pg_statio_user_tables io using (relid)
        group by 1 order by 1`,
    );
    const database = await client.query(
      `select xact_commit::float8, xact_rollback::float8, deadlocks::float8, temp_files::float8, temp_bytes::float8,
              blks_hit::float8, blks_read::float8
         from pg_stat_database where datname = current_database()`,
    );
    const others = await client.query<{ datname: string; xact_commit: number }>(
      `select datname, xact_commit::float8 as xact_commit from pg_stat_database
        where datname is not null and datname <> current_database()`,
    );
    const wal = await client.query("select wal_records::float8, wal_fpi::float8, wal_bytes::float8 from pg_stat_wal");
    const checkpointer = await client.query("select num_timed::float8, num_requested::float8, num_done::float8, buffers_written::float8 from pg_stat_checkpointer");
    const progress = await client.query(
      `select (select count(*) from pg_stat_progress_vacuum where datname = current_database())::int as vacuums,
              (select count(*) from pg_stat_progress_analyze where datname = current_database())::int as analyzes`,
    );
    return {
      at: new Date().toISOString(),
      tables: tables.rows as Record<string, number | string>[],
      database: database.rows[0] as Record<string, number>,
      otherCommits: Object.fromEntries(others.rows.map((r) => [r.datname, Number(r.xact_commit)])) as Record<string, number>,
      wal: wal.rows[0] as Record<string, number>,
      checkpointer: checkpointer.rows[0] as Record<string, number>,
      progress: progress.rows[0] as { vacuums: number; analyzes: number },
    };
  } finally {
    await client.end();
  }
}

export type StatsSnapshot = Awaited<ReturnType<typeof snapshotStats>>;
