import { MAX_REPORT_ROWS, type ReportQuery, type ReportResult } from "@event-analytics/shared";
import type pg from "pg";
import { RETENTION_DAYS } from "../db/partitions.js";
import { buildBucketsSql, buildReportSql, buildStaleSql, END, reportSource, START, toReportBuckets, toReportRows } from "./sql.js";

// 리포트를 돌린다(DESIGN 6.3, 10장 35). 읽기 전용 트랜잭션에서 문장 30초, 잠금 대기 3초로 묶는다(트랜잭션 안에서만).

export class ReportFailed extends Error {
  constructor(
    readonly code: "too_many_rows" | "out_of_retention" | "report_timeout" | "busy",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

// asOf: 보관 기간과 provisional을 판단할 "지금"(ISO). 테스트가 실제 날짜와 상관없이 같은 결과를 보게 넘긴다. 없으면 DB의 now()다.
// forceRaw: 집계 표를 쓸 수 있어도 원본으로 센다(테스트가 두 경로를 견줄 때, 측정 도구의 --raw).
export type ReportOptions = { maxRows?: number; statementTimeout?: string; lockTimeout?: string; asOf?: string; forceRaw?: boolean };

export async function runReport(
  pool: pg.Pool,
  q: ReportQuery,
  { maxRows = MAX_REPORT_ROWS, statementTimeout = "30s", lockTimeout = "3s", asOf, forceRaw = false }: ReportOptions = {},
): Promise<ReportResult> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    throw new ReportFailed("busy", "DB 연결을 얻지 못했습니다. 잠시 뒤 다시 하세요", { cause: err });
  }
  try {
    // 반복 읽기: 행·묶음·워터마크·stale을 한 스냅샷에서 본다.
    await client.query("begin read only isolation level repeatable read");
    await client.query("select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)", [
      statementTimeout,
      lockTimeout,
    ]);
    // 기간을 리포트 시간대로 바꾼 순간, 보관 기간의 시작(UTC 날짜로 90일 전 0시), 끝이 최근 7일 안인지(늦은 이벤트가 더 온다),
    // 집계 표의 워터마크. 워터마크는 여기서 읽어 리포트 문장에 매개변수로 넘긴다(반복 읽기라 같은 스냅샷이고, 계획할 때 가지를 친다).
    const range = await client.query<{ from: Date; to: Date; retained_from: Date; provisional: boolean; watermark: Date | null }>(
      `select ${START} as "from", ${END} as "to",
              ((coalesce($4::timestamptz, now()) at time zone 'UTC')::date - $5::int)::timestamp at time zone 'UTC' as retained_from,
              ${END} > coalesce($4::timestamptz, now()) - interval '7 days' as provisional,
              (select watermark from rollup_state) as watermark`,
      [q.from, q.to, q.timezone, asOf ?? null, RETENTION_DAYS],
    );
    const { from, to, retained_from: retainedFrom, provisional, watermark } = range.rows[0]!;
    // 조용히 0을 주면 "그때는 이벤트가 없었다"로 읽힌다. 시작 날이 일부만 남은 경우도 거절한다.
    if (from < retainedFrom) {
      throw new ReportFailed("out_of_retention", `보관 기간(90일) 밖입니다. 기간의 시작은 ${retainedFrom.toISOString()} 이후여야 합니다`);
    }
    // 기간이 워터마크에서(또는 뒤에서) 시작하면 집계 표 부분이 비어 원본만 센다. 상태 행이 없으면(집계 작업이 오류를 남긴다) 원본으로 센다.
    const source = !forceRaw && watermark && watermark > from ? reportSource(q) : "raw";
    // 잘라 주지 않는다(잘린 표를 전체로 오해하지 않게). 하나 더 읽어 넘는지 본다.
    const { text, values } = buildReportSql(q, maxRows + 1, source === "rollup" ? watermark! : undefined);
    const { rows } = await client.query(text, values);
    if (rows.length > maxRows) {
      throw new ReportFailed("too_many_rows", `행이 ${maxRows}개를 넘습니다. 기간이나 차원을 줄이세요`);
    }
    let rollupWatermark: string | null = null;
    let stale = false;
    if (source === "rollup") {
      const staleSql = buildStaleSql(q, watermark!);
      stale = (await client.query<{ stale: boolean }>(staleSql.text, staleSql.values)).rows[0]!.stale;
      rollupWatermark = watermark!.toISOString();
    }
    const buckets = buildBucketsSql(q);
    const bucketRows = (await client.query(buckets.text, buckets.values)).rows;
    await client.query("commit");
    return {
      rows: toReportRows(q, rows),
      meta: {
        timezone: q.timezone,
        rangeStart: from.toISOString(),
        rangeEnd: to.toISOString(),
        rowCount: rows.length,
        source,
        rollupWatermark,
        stale,
        provisional,
        buckets: toReportBuckets(q, bucketRows),
      },
    };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw failure(err) ?? err;
  } finally {
    client.release();
  }
}

function failure(err: unknown) {
  if (err instanceof ReportFailed) return err;
  const code = (err as { code?: string }).code;
  if (code === "57014") return new ReportFailed("report_timeout", "리포트가 시간 한도를 넘었습니다. 기간을 줄이세요", { cause: err });
  if (code === "55P03" || code === "40P01") return new ReportFailed("busy", "DB가 바빠 처리하지 못했습니다. 잠시 뒤 다시 하세요", { cause: err });
  return null;
}
