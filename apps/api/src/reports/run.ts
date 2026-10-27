import { MAX_REPORT_ROWS, type ReportQuery, type ReportResult } from "@event-analytics/shared";
import type pg from "pg";
import { RETENTION_DAYS } from "../db/partitions.js";
import { buildBucketsSql, buildReportSql, buildStaleSql, END, reportSource, START, toReportBuckets, toReportRows } from "./sql.js";
import { checkRetention, inReportTransaction, type QueryLimits, ReportFailed, retainedFromSql } from "./transaction.js";

// 리포트를 돌린다(DESIGN 6.3, 10장 35). 트랜잭션 틀(읽기 전용 반복 읽기, 문장 30초, 잠금 대기 3초)은 transaction.ts가 연다.

// asOf: 보관 기간과 provisional을 판단할 "지금"(ISO). 테스트가 실제 날짜와 상관없이 같은 결과를 보게 넘긴다. 없으면 DB의 now()다.
// forceRaw: 집계 표를 쓸 수 있어도 원본으로 센다(테스트가 두 경로를 견줄 때, 측정 도구의 --raw).
export type ReportOptions = QueryLimits & { maxRows?: number; asOf?: string; forceRaw?: boolean };

export function runReport(
  pool: pg.Pool,
  q: ReportQuery,
  { maxRows = MAX_REPORT_ROWS, asOf, forceRaw = false, ...limits }: ReportOptions = {},
): Promise<ReportResult> {
  // 반복 읽기: 행·묶음·워터마크·stale을 한 스냅샷에서 본다.
  return inReportTransaction(pool, limits, async (client) => {
    // 기간을 리포트 시간대로 바꾼 순간, 보관 기간의 시작(UTC 날짜로 90일 전 0시), 끝이 최근 7일 안인지(늦은 이벤트가 더 온다),
    // 집계 표의 워터마크. 워터마크는 여기서 읽어 리포트 문장에 매개변수로 넘긴다(반복 읽기라 같은 스냅샷이고, 계획할 때 가지를 친다).
    const range = await client.query<{ from: Date; to: Date; retained_from: Date; provisional: boolean; watermark: Date | null }>(
      `select ${START} as "from", ${END} as "to",
              ${retainedFromSql("$4", "$5")} as retained_from,
              ${END} > coalesce($4::timestamptz, now()) - interval '7 days' as provisional,
              (select watermark from rollup_state) as watermark`,
      [q.from, q.to, q.timezone, asOf ?? null, RETENTION_DAYS],
    );
    const { from, to, retained_from: retainedFrom, provisional, watermark } = range.rows[0]!;
    checkRetention(from, retainedFrom);
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
  });
}
