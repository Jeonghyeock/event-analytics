import { MAX_REPORT_ROWS, type ReportQuery, type ReportResult } from "@event-analytics/shared";
import type pg from "pg";
import { buildReportSql, toReportRows } from "./sql.js";

// 리포트를 돌린다(DESIGN 6.3, 10장 35). 읽기 전용 트랜잭션에서 문장 30초, 잠금 대기 3초로 묶는다(트랜잭션 안에서만).

export class ReportFailed extends Error {
  constructor(
    readonly code: "too_many_rows" | "report_timeout" | "busy",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type ReportOptions = { maxRows?: number; statementTimeout?: string; lockTimeout?: string };

export async function runReport(
  pool: pg.Pool,
  q: ReportQuery,
  { maxRows = MAX_REPORT_ROWS, statementTimeout = "30s", lockTimeout = "3s" }: ReportOptions = {},
): Promise<ReportResult> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    throw new ReportFailed("busy", "DB 연결을 얻지 못했습니다. 잠시 뒤 다시 하세요", { cause: err });
  }
  try {
    await client.query("begin read only");
    await client.query("select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)", [
      statementTimeout,
      lockTimeout,
    ]);
    // 잘라 주지 않는다(잘린 표를 전체로 오해하지 않게). 하나 더 읽어 넘는지 본다.
    const { text, values } = buildReportSql(q, maxRows + 1);
    const { rows } = await client.query(text, values);
    const range = await client.query<{ from: Date; to: Date }>(
      `select ($1::date::timestamp at time zone $3::text) as "from", (($2::date + 1)::timestamp at time zone $3::text) as "to"`,
      [q.from, q.to, q.timezone],
    );
    await client.query("commit");
    if (rows.length > maxRows) {
      throw new ReportFailed("too_many_rows", `행이 ${maxRows}개를 넘습니다. 기간이나 차원을 줄이세요`);
    }
    return {
      rows: toReportRows(q, rows),
      meta: {
        timezone: q.timezone,
        from: range.rows[0]!.from.toISOString(),
        to: range.rows[0]!.to.toISOString(),
        rowCount: rows.length,
        source: "raw",
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
