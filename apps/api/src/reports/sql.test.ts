import { ReportQuery } from "@event-analytics/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import { createPool } from "../db/pool.js";
import { buildReportSql } from "./sql.js";

// SQL 만들기(DESIGN 6.3, 10장 32). 값이 SQL 글자에 들어가지 않는지, 요청한 지표만 세는지, 만든 SQL이 실제로 도는지 본다.
// 손으로 센 값과의 비교(A5)는 리포트 경로 테스트에서 한다.
const query = (patch: Record<string, unknown> = {}) =>
  ReportQuery.parse({ metrics: ["events"], from: "2026-10-20", to: "2026-10-26", granularity: "day", ...patch });

describe("buildReportSql", () => {
  it("필터 값과 날짜·시간대는 매개변수로만 가고 SQL 글자에는 없다", () => {
    const evil = "x'); drop table events; --";
    const { text, values } = buildReportSql(
      query({ filters: [{ dimension: "campaign", values: [evil, "camp_001"] }, { dimension: "platform", values: ["ios"] }] }),
      5_001,
    );
    expect(text).not.toContain(evil);
    expect(text).not.toContain("2026-10-20");
    expect(text).not.toContain("Asia/Seoul");
    expect(text).toContain("campaign = any($4::text[])");
    expect(text).toContain("platform = any($5::text[])");
    expect(values).toEqual(["2026-10-20", "2026-10-26", "Asia/Seoul", [evil, "camp_001"], ["ios"]]);
  });

  it("users를 고르지 않으면 count(distinct)를 하지 않는다", () => {
    expect(buildReportSql(query(), 10).text).not.toContain("count(distinct");
    expect(buildReportSql(query({ metrics: ["users"] }), 10).text).toContain("count(distinct user_id) as users");
  });

  it("차원은 상수 표의 열 이름으로 묶는다", () => {
    const { text } = buildReportSql(query({ dimensions: ["channel", "country"] }), 10);
    expect(text).toContain("channel as d0, country as d1");
    expect(text).toContain("group by 1, 2, 3");
    expect(text).toContain("order by bucket, d0, d1");
  });

  it("total은 기간의 시작 순간 하나로 묶고, 나머지는 시간대로 자른다", () => {
    expect(buildReportSql(query({ granularity: "total" }), 10).text).toContain("($1::date::timestamp at time zone $3::text) as bucket");
    expect(buildReportSql(query({ granularity: "week" }), 10).text).toContain("date_trunc('week', occurred_at, $3::text) as bucket");
  });
});

describe("만든 SQL이 도는지", () => {
  const pool = createPool({ connectionString: inject("databaseUrl"), max: 1 });
  afterAll(() => pool.end());

  it.each([
    ["hour", ["events", "users"], ["platform"]],
    ["day", ["users"], []],
    ["week", ["events"], ["campaign", "country"]],
    ["total", ["events", "users"], ["event_name"]],
  ] as const)("%s 단위", async (granularity, metrics, dimensions) => {
    const { text, values } = buildReportSql(
      query({ granularity, metrics, dimensions, filters: [{ dimension: "platform", values: ["ios", "web"] }], timezone: "America/New_York" }),
      10,
    );
    await expect(pool.query(text, values)).resolves.toBeDefined();
  });
});
