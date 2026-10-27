import type pg from "pg";

// events의 일 단위(UTC) 파티션(DESIGN 6.2). 날짜는 UTC의 'YYYY-MM-DD'다.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export const utcDay = (date: Date) => date.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
export const partitionName = (day: string) => `events_p${day.replaceAll("-", "")}`;

// from부터 to까지(둘 다 포함) 없는 날의 파티션을 만들고, 만든 이름을 돌려준다. 소유자로 부른다(앱 role은 표를 만들 수 없다).
// 경계는 오프셋을 붙인 글자로 써서 세션 시간대와 상관없이 UTC 자정이다(DESIGN 10장 14).
// CREATE TABLE … PARTITION OF는 부모 표에 AccessExclusiveLock을 걸어 그동안 수집과 리포트가 멈춘다.
// 1단계는 준비(테스트 템플릿, 개발 DB)에서만 부른다. 수집이 도는 중에 만드는 방법은 2단계에서 정한다(ATTACH).
export async function createDailyPartitions(client: pg.ClientBase, from: string, to: string): Promise<string[]> {
  if (!DAY.test(from) || !DAY.test(to) || addDays(from, 0) !== from || addDays(to, 0) !== to) {
    throw new Error(`날짜는 YYYY-MM-DD입니다: ${from}, ${to}`);
  }
  const created: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const name = partitionName(day);
    const { rows } = await client.query<{ missing: boolean }>("select to_regclass($1) is null as missing", [name]);
    if (!rows[0]!.missing) continue;
    await client.query(
      `CREATE TABLE ${name} PARTITION OF events FOR VALUES FROM ('${day} 00:00+00') TO ('${addDays(day, 1)} 00:00+00')`,
    );
    created.push(name);
  }
  return created;
}
