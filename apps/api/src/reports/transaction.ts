import type pg from "pg";

// 리포트·퍼널·리텐션이 함께 쓰는 틀(DESIGN 6.3·6.5, 10장 35·46). 풀에서 연결 하나를 빌려 읽기 전용 반복 읽기 트랜잭션을 열고,
// 문장 30초·잠금 대기 3초를 트랜잭션 안에서만 건다. 반복 읽기라 한 요청의 문장들이 한 스냅샷을 본다.
// DB 오류 가운데 시간 한도와 잠금 대기·교착·연결 대기는 503의 이유로 바꾼다.

export class ReportFailed extends Error {
  constructor(
    readonly code: "too_many_rows" | "out_of_retention" | "report_timeout" | "busy",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type QueryLimits = { statementTimeout?: string; lockTimeout?: string };

// 리포트 종류마다 계획을 바꾸는 설정. 트랜잭션 안에서만 건다(set_config(…, true)). API의 실행 함수와 진단 도구(load:report-bench의
// EXPLAIN)가 같은 함수를 불러, 7단계의 고침으로 더한 설정이 진단 계획에도 걸린다(DESIGN 6.8).
export type ReportKind = "report" | "funnel" | "retention";

export async function applyPlannerSettings(client: pg.PoolClient, kind: ReportKind) {
  if (kind === "funnel" || kind === "retention") {
    // 중첩 반복 조인을 끈다(10장 47). 원본에 user_id 인덱스가 없어 중첩 반복은 단계 이벤트를 바깥 행마다 다시 훑는다.
    // 퍼널: 계획기는 통계와 상관없이 그것을 고를 수 있다. 조인 조건의 전환 기간 범위(t > 앞 단계, t < t1 + 기간)에 기본 선택도를 써서
    // 2단계부터를 1행쯤으로 어림하기 때문이다. 통계가 다 있는 개발 DB에서도 좁은 필터 퍼널이 켜면 61초, 끄면 0.4초였고(코드 리뷰),
    // 통계가 없는 새 DB에서는 진입 사용자를 8명으로 어림해 3만 건에 39초였다(끄면 31ms). ANALYZE로는 고쳐지지 않는다.
    // 리텐션: 같은 위험에 대비해 끈다. 안쪽이 원본이 아니라 미리 묶은 돌아옴(b)이라, 개발 DB와 통계 없는 DB의 14가지 모양에서
    // 계획이 켜도 꺼도 같았다(병합·해시 조인, 코드 리뷰). user_id 인덱스를 더하면 이 설정을 다시 본다(그 인덱스가 여는 계획을 막는다).
    await client.query("select set_config('enable_nestloop', 'off', true)");
  }
}

export async function inReportTransaction<T>(
  pool: pg.Pool,
  { statementTimeout = "30s", lockTimeout = "3s" }: QueryLimits,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    throw new ReportFailed("busy", "DB 연결을 얻지 못했습니다. 잠시 뒤 다시 하세요", { cause: err });
  }
  try {
    await client.query("begin read only isolation level repeatable read");
    await client.query("select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)", [
      statementTimeout,
      lockTimeout,
    ]);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw failure(err) ?? err;
  } finally {
    client.release();
  }
}

// 보관 기간의 시작(UTC 날짜로 90일 전 0시). asOf와 days는 매개변수 자리다(예: "$4", "$5"). asOf가 null이면 DB의 now()다.
export const retainedFromSql = (asOf: string, days: string) =>
  `((coalesce(${asOf}::timestamptz, now()) at time zone 'UTC')::date - ${days}::int)::timestamp at time zone 'UTC'`;

// 조용히 0을 주면 "그때는 이벤트가 없었다"로 읽힌다. 시작 날이 일부만 남은 경우도 거절한다.
export function checkRetention(from: Date, retainedFrom: Date) {
  if (from < retainedFrom) {
    throw new ReportFailed("out_of_retention", `보관 기간(90일) 밖입니다. 기간의 시작은 ${retainedFrom.toISOString()} 이후여야 합니다`);
  }
}

function failure(err: unknown) {
  if (err instanceof ReportFailed) return err;
  const code = (err as { code?: string }).code;
  if (code === "57014") return new ReportFailed("report_timeout", "리포트가 시간 한도를 넘었습니다. 기간을 줄이세요", { cause: err });
  if (code === "55P03" || code === "40P01") return new ReportFailed("busy", "DB가 바빠 처리하지 못했습니다. 잠시 뒤 다시 하세요", { cause: err });
  return null;
}

// 경로의 응답: 행이 너무 많거나 보관 기간 밖이면 422, 시간 한도·DB가 바쁘면 503. ReportFailed가 아니면 null(그대로 던져 500).
export function failureReply(err: unknown) {
  if (!(err instanceof ReportFailed)) return null;
  const status = err.code === "too_many_rows" || err.code === "out_of_retention" ? 422 : 503;
  return { status, body: { error: err.message, code: err.code } } as const;
}
