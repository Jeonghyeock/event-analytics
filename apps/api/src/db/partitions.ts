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
      where i.inhparent = 'events'::regclass
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
// 경계는 오프셋을 붙인 글자로 써서 세션 시간대와 상관없이 UTC 자정이다(DESIGN 10장 14).
export async function createDailyPartitions(
  client: pg.ClientBase,
  from: string,
  to: string,
  { retryDelaysMs = RETRY_DELAYS_MS }: Options = {},
): Promise<string[]> {
  checkDay(from, to);
  const existing = new Set((await listPartitions(client)).map((p) => p.name));
  const created: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const name = partitionName(day);
    if (existing.has(name)) continue;
    await withLockRetry(async () => {
      await client.query("begin");
      try {
        await client.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
        await client.query(`CREATE TABLE ${name} (LIKE events INCLUDING ALL)`);
        await client.query(
          `ALTER TABLE events ATTACH PARTITION ${name} FOR VALUES FROM ('${day} 00:00+00') TO ('${addDays(day, 1)} 00:00+00')`,
        );
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      }
    }, retryDelaysMs);
    created.push(name);
  }
  return created;
}

// 지금 붙어 있지 않은 날(from~to, 둘 다 포함). 앱 role도 부를 수 있다(카탈로그만 읽음).
export async function missingPartitionDays(client: pg.ClientBase | pg.Pool, from: string, to: string) {
  checkDay(from, to);
  const { rows } = await client.query<{ name: string }>(
    `select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'events'::regclass and not i.inhdetachpending`,
  );
  const attached = new Set(rows.map((r) => r.name));
  const missing: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) if (!attached.has(partitionName(day))) missing.push(day);
  return missing;
}

export type MaintainResult = { finalized: string[]; created: string[]; dropped: string[] };

// 관리 작업(db:maintain). 여러 번 돌려도 같은 결과다. 트랜잭션 밖의 연결로 부른다(CONCURRENTLY).
// 1) 중간에 끊긴 떼기를 마무리한다. 떼는 중인 파티션이 있으면 다른 파티션을 뗄 수 없다(55000, 확인함).
// 2) today − 7일부터 today + 7일까지 없는 날을 만든다.
// 3) today − 90일보다 앞선 날을 CONCURRENTLY로 떼고 지운다.
export async function maintain(
  client: pg.ClientBase,
  { today = utcDay(new Date()), retryDelaysMs = RETRY_DELAYS_MS }: Options & { today?: string } = {},
): Promise<MaintainResult> {
  checkDay(today);
  const result: MaintainResult = { finalized: [], created: [], dropped: [] };
  const oldest = addDays(today, -RETENTION_DAYS);
  await client.query(`set lock_timeout = '${LOCK_TIMEOUT}'`);
  try {
    for (const p of (await listPartitions(client)).filter((p) => p.pending)) {
      await withLockRetry(() => client.query(`ALTER TABLE events DETACH PARTITION ${p.name} FINALIZE`), retryDelaysMs);
      result.finalized.push(p.name);
      // 떼다 끊긴 것은 보관 기간이 지나 떼던 것이다. 마저 지운다.
      if (p.day < oldest) await dropTable(client, p.name, retryDelaysMs, result);
    }
    result.created = await createDailyPartitions(client, addDays(today, -BEHIND_DAYS), addDays(today, AHEAD_DAYS), {
      retryDelaysMs,
    });
    for (const p of (await listPartitions(client)).filter((p) => p.day < oldest)) {
      // CONCURRENTLY는 그 파티션을 볼 수 있는 트랜잭션이 끝나길 한도 없이 기다린다. 기다리는 동안 INSERT·SELECT를 막지 않는다
      // (부모에 ShareUpdateExclusiveLock). 그래서 마이그레이션 실행기의 CONCURRENTLY처럼 잠금 대기 한도를 끈다.
      await client.query("set lock_timeout = 0");
      try {
        await client.query(`ALTER TABLE events DETACH PARTITION ${p.name} CONCURRENTLY`);
      } finally {
        await client.query(`set lock_timeout = '${LOCK_TIMEOUT}'`).catch(() => {});
      }
      await dropTable(client, p.name, retryDelaysMs, result);
    }
  } finally {
    await client.query("reset lock_timeout").catch(() => {});
  }
  return result;
}

// 뗀 표는 아무 쿼리도 보지 않으므로 지우기는 그 표만 잠근다.
async function dropTable(client: pg.ClientBase, name: string, retryDelaysMs: number[], result: MaintainResult) {
  await withLockRetry(() => client.query(`DROP TABLE ${name}`), retryDelaysMs);
  result.dropped.push(name);
}
