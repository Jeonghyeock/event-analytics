import type pg from "pg";

// events의 일 단위(UTC) 파티션과 관리 작업(DESIGN 6.2). 날짜는 UTC의 'YYYY-MM-DD'다. 소유자로 부른다(앱 role은 표를 만들 수 없다).
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NAME = /^events_p(\d{4})(\d{2})(\d{2})$/;
const DAY_MS = 86_400_000;

// 받을 기간(과거 7일)을 덮고, 관리 작업이 멈춰도 7일은 버티게 앞으로 7일을 미리 만든다. 보관은 90일이다(DESIGN 10장 4).
export const BEHIND_DAYS = 7;
export const AHEAD_DAYS = 7;
export const RETENTION_DAYS = 90;
// 마이그레이션 실행기와 같다. 잠금은 1초만 기다리고, 닿으면 쉬었다가 다시 한다(DESIGN 10장 24).
const LOCK_TIMEOUT = "1s";
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

export const utcDay = (date: Date) => date.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
export const partitionName = (day: string) => `events_p${day.replaceAll("-", "")}`;
const dayOf = (name: string) => {
  const m = NAME.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function checkDay(...days: string[]) {
  for (const day of days) {
    if (!DAY.test(day) || addDays(day, 0) !== day) throw new Error(`날짜는 YYYY-MM-DD입니다: ${day}`);
  }
}

type Options = { retryDelaysMs?: number[] };

async function withLockRetry<T>(work: () => Promise<T>, delays: number[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if ((err as { code?: string }).code !== "55P03" || attempt >= delays.length) throw err;
      await sleep(delays[attempt]!);
    }
  }
}

// 붙어 있는 파티션. 이름이 규칙(events_pYYYYMMDD)에 맞지 않는 것은 건드리지 않는다.
export async function listPartitions(client: pg.ClientBase) {
  const { rows } = await client.query<{ name: string; pending: boolean }>(
    `select c.relname as name, i.inhdetachpending as pending
       from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'public.events'::regclass and c.relnamespace = 'public'::regnamespace
      order by 1`,
  );
  return rows.flatMap((r) => {
    const day = dayOf(r.name);
    return day ? [{ name: r.name, day, pending: r.pending }] : [];
  });
}

// from부터 to까지(둘 다 포함) 없는 날의 파티션을 만들고, 만든 이름을 돌려준다.
// CREATE TABLE … PARTITION OF는 부모 표를 AccessExclusiveLock으로 잠가 그동안 수집과 리포트가 멈춘다.
// 그래서 따로 만든 빈 표를 ATTACH로 붙인다. 부모에는 ShareUpdateExclusiveLock만 걸려 INSERT·SELECT와 부딪히지 않는다.
// 기본 키 인덱스는 새 표의 것이 부모 인덱스에 붙고, 권한은 소유자의 기본 권한으로 붙는다.
// 만들기와 붙이기를 한 트랜잭션으로 해, 붙이다 실패하면 따로 만든 표도 남지 않는다.
// 있는지는 이름이 아니라 pg_inherits(붙어 있는지)로 본다. 그 날 이름의 표가 붙지 않은 채 남아 있으면 그 표를 붙인다
// (붙일 때 PostgreSQL이 경계 밖 행이 없는지 훑는다).
// 경계는 오프셋을 붙인 글자로 써서 세션 시간대와 상관없이 UTC 자정이다(DESIGN 10장 14).
export async function createDailyPartitions(
  client: pg.ClientBase,
  from: string,
  to: string,
  options: Options = {},
): Promise<string[]> {
  const { created, errors } = await attachDays(client, from, to, options);
  if (errors.length > 0) throw new Error(`파티션을 만들지 못했습니다: ${errors.join("; ")}`);
  return created;
}

// 하루가 실패해도(붙지 않은 표에 경계 밖 행이 있는 등) 다음 날을 계속 만든다. 하나의 실패가 오늘의 파티션까지 막지 않게.
async function attachDays(client: pg.ClientBase, from: string, to: string, { retryDelaysMs = RETRY_DELAYS_MS }: Options) {
  checkDay(from, to);
  outsideTransaction(client);
  const existing = new Set((await listPartitions(client)).map((p) => p.name));
  const loose = new Set(await looseTables(client));
  const created: string[] = [];
  const errors: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const name = partitionName(day);
    if (existing.has(name)) continue;
    try {
      await withLockRetry(async () => {
        await client.query("begin");
        try {
          await client.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
          if (!loose.has(name)) await client.query(`CREATE TABLE public.${name} (LIKE public.events INCLUDING ALL)`);
          await client.query(
            `ALTER TABLE public.events ATTACH PARTITION public.${name} FOR VALUES FROM ('${day} 00:00+00') TO ('${addDays(day, 1)} 00:00+00')`,
          );
          await client.query("commit");
        } catch (err) {
          await client.query("rollback").catch(() => {});
          throw err;
        }
      }, retryDelaysMs);
      created.push(name);
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  }
  return { created, errors };
}

// 이 모듈의 함수는 트랜잭션을 스스로 연다. 부른 쪽이 트랜잭션 안이면 BEGIN이 경고만 내고, 우리 COMMIT이 그 트랜잭션을 끝내 버린다.
function outsideTransaction(client: pg.ClientBase) {
  if (client.getTransactionStatus() !== "I") throw new Error("파티션 관리는 트랜잭션 밖의 연결로 부릅니다");
}

// 이름이 events_pYYYYMMDD인데 events에 붙어 있지 않은 표(뗐지만 지우지 못한 것 등).
async function looseTables(client: pg.ClientBase) {
  const { rows } = await client.query<{ name: string }>(
    `select c.relname as name from pg_class c
      where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace and c.relname like 'events_p%'
        and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)`,
  );
  return rows.map((r) => r.name).filter((name) => dayOf(name) !== null);
}

// DB 시각의 UTC 날짜(DESIGN 10장 16). 앱 서버와 DB의 시계가 달라도 관리 작업과 수집이 같은 "오늘"을 쓴다.
export async function dbToday(client: pg.ClientBase | pg.Pool) {
  const { rows } = await client.query<{ today: string }>("select to_char(now() at time zone 'UTC', 'YYYY-MM-DD') as today");
  return rows[0]!.today;
}

// 지금 붙어 있지 않은 날(from~to, 둘 다 포함). 앱 role도 부를 수 있다(카탈로그만 읽음).
export async function missingPartitionDays(client: pg.ClientBase | pg.Pool, from: string, to: string) {
  checkDay(from, to);
  const { rows } = await client.query<{ name: string }>(
    `select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'public.events'::regclass and c.relnamespace = 'public'::regnamespace and not i.inhdetachpending`,
  );
  const attached = new Set(rows.map((r) => r.name));
  const missing: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) if (!attached.has(partitionName(day))) missing.push(day);
  return missing;
}

export type MaintainResult = { created: string[]; finalized: string[]; dropped: string[]; analyzed: boolean; errors: string[] };

// 부모 표(events)의 통계(DESIGN 6.2 5단계, 10장 62). autovacuum은 파티션 부모를 분석하지 않는다(PostgreSQL의 설계).
// 부모의 통계는 파티션을 가로지르는 묶기·조인의 어림에 쓰이고, 없으면 기본값(무리 200 × 200 = 4만)이 된다. 리텐션 31일은 그 어림으로
// 병렬 해시 묶기를 골라 리더의 마지막 묶기가 문장 한도 30초를 넘겼다(실제 무리 115만~237만, 7단계 측정). ONLY: 잎은 다시 분석하지 않는다
// (autovacuum의 일). 부모에 ShareUpdateExclusiveLock을 건다(수집·리포트는 막지 않는다). 측정 실행기도 복제한 뒤 이것을 부른다(관리 작업이
// 하는 일과 같게). 권한이 없으면 ANALYZE는 경고만 내고 건너뛰지만, 관리 작업은 소유자 확인(checkOwner) 뒤에 돈다.
export async function analyzeParent(client: pg.ClientBase) {
  await client.query("ANALYZE ONLY public.events");
}

// 관리 작업이 겹쳐 돌지 않게 잡는 advisory lock 번호(같은 DB 안에서만 뜻이 있다).
const MAINTAIN_LOCK = 7_340_203;
// CONCURRENTLY 떼기의 문장 시간 한도. 부모 표에 잠금을 쥔 트랜잭션이 끝나길 기다리므로, 잊힌 트랜잭션 앞에서 끝나지 않을 수 있다.
const DETACH_TIMEOUT = "5min";

// 관리 작업(db:maintain, DESIGN 6.2). 여러 번 돌려도 같은 결과다. 트랜잭션 밖의 연결로 부른다(CONCURRENTLY).
// 순서: 1) 만들기 2) 끊긴 떼기 마무리 3) 보관 기간이 지난 날 떼고 지우기 4) 붙지 않은 채 남은 표 치우기 5) 부모 표의 통계.
// 한 단계가 실패해도 다음 단계를 돌리고 errors에 남긴다. 부르는 쪽은 errors가 있으면 실패로 끝낸다.
// 수집에 가장 중요한 만들기를 먼저 한다. 떼는 중인 파티션이 남아 있으면 다른 파티션을 뗄 수 없어(55000) 떼기를 건너뛴다.
export async function maintain(
  client: pg.ClientBase,
  { today, retryDelaysMs = RETRY_DELAYS_MS, detachTimeout = DETACH_TIMEOUT }: Options & { today?: string; detachTimeout?: string } = {},
): Promise<MaintainResult> {
  outsideTransaction(client);
  const result: MaintainResult = { created: [], finalized: [], dropped: [], analyzed: false, errors: [] };
  const locked = (await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [MAINTAIN_LOCK])).rows[0]!.ok;
  if (!locked) throw new Error("다른 관리 작업이 돌고 있습니다");
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      result.errors.push(`${name}: ${(err as Error).message}`);
    }
  };
  try {
    const day = today ?? (await dbToday(client));
    checkDay(day);
    const oldest = addDays(day, -RETENTION_DAYS);
    await client.query(`set lock_timeout = '${LOCK_TIMEOUT}'`);

    // 하루마다 실패를 모은다. 만든 것은 실패가 있어도 결과에 남는다.
    const create = async () => {
      const { created, errors } = await attachDays(client, addDays(day, -BEHIND_DAYS), addDays(day, AHEAD_DAYS), { retryDelaysMs });
      result.created.push(...created);
      result.errors.push(...errors.map((e) => `만들기: ${e}`));
    };
    await step("만들기", create);

    // FINALIZE는 DB의 더 오래된 스냅샷이 모두 끝나길 기다린다. 잠금 대기 1초로 묶어, 기다리는 동안 부모를 쥐어 다른 일을 막지 않게 한다.
    await step("마무리", async () => {
      for (const p of (await listPartitions(client)).filter((p) => p.pending)) {
        await withLockRetry(() => client.query(`ALTER TABLE public.events DETACH PARTITION public.${p.name} FINALIZE`), retryDelaysMs);
        result.finalized.push(p.name);
      }
    });
    // 만들 범위 안의 파티션을 마무리했으면 그 날이 비었다(떼던 것이 끝났으므로). 바로 다시 붙인다.
    if (result.finalized.length > 0) await step("만들기", create);

    await step("떼기", async () => {
      const partitions = await listPartitions(client);
      if (partitions.some((p) => p.pending)) throw new Error("떼는 중인 파티션이 남아 있어 건너뜁니다(다음 실행이 마무리부터 합니다)");
      for (const p of partitions.filter((p) => p.day < oldest)) {
        // CONCURRENTLY는 잠금 줄을 만들지 않아(부모에 ShareUpdateExclusiveLock) 잠금 대기 한도를 끈다.
        // 대신 문장 시간 한도를 둔다. 닿으면 떼는 중으로 남고 다음 실행이 마무리한다.
        await client.query(`set lock_timeout = 0; set statement_timeout = '${detachTimeout}'`);
        try {
          await client.query(`ALTER TABLE public.events DETACH PARTITION public.${p.name} CONCURRENTLY`);
        } finally {
          await client.query(`set lock_timeout = '${LOCK_TIMEOUT}'; reset statement_timeout`).catch(() => {});
        }
        // 지우기가 실패해도 다른 날은 계속 뗀다. 남은 표는 치우기 단계가 다시 지운다.
        await dropTable(client, p.name, retryDelaysMs, result).catch((err: Error) => result.errors.push(`떼기: ${p.name} 지우기: ${err.message}`));
      }
    });

    // 뗐지만 지우지 못한 표(마무리한 것, DROP 직전에 끊긴 것). 보관 기간이 지난 것만 지운다.
    await step("치우기", async () => {
      for (const name of await looseTables(client)) {
        if (dayOf(name)! < oldest) await dropTable(client, name, retryDelaysMs, result);
      }
    });

    // 붙이고 뗀 뒤의 파티션들로 센다. analyzed는 ANALYZE가 오류 없이 끝났다는 뜻이다(행이 없으면 통계는 생기지 않는다).
    await step("부모 통계", async () => {
      await withLockRetry(() => analyzeParent(client), retryDelaysMs);
      result.analyzed = true;
    });
  } finally {
    await client.query("reset lock_timeout").catch(() => {});
    await client.query("select pg_advisory_unlock($1)", [MAINTAIN_LOCK]).catch(() => {});
  }
  return result;
}

// 뗀 표는 아무 쿼리도 보지 않으므로 지우기는 그 표만 잠근다.
async function dropTable(client: pg.ClientBase, name: string, retryDelaysMs: number[], result: MaintainResult) {
  await withLockRetry(() => client.query(`DROP TABLE public.${name}`), retryDelaysMs);
  result.dropped.push(name);
}
