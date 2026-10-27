import { ReportQuery } from "@event-analytics/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import { createPool } from "../db/pool.js";
import { buildBucketsSql, buildReportSql, toReportBuckets } from "./sql.js";

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

  it("null을 고르면 값이 없는 것도 남긴다(IN은 NULL과 맞지 않으므로 따로)", () => {
    const both = buildReportSql(query({ filters: [{ dimension: "campaign", values: [null, "camp_001"] }] }), 10);
    expect(both.text).toContain("(campaign = any($4::text[]) or campaign is null)");
    expect(both.values[3]).toEqual(["camp_001"]);
    const onlyNull = buildReportSql(query({ filters: [{ dimension: "country", values: [null] }] }), 10);
    expect(onlyNull.text).toContain("and country is null");
    expect(onlyNull.values).toHaveLength(3);
  });

  it("users를 고르지 않으면 count(distinct)를 하지 않는다", () => {
    expect(buildReportSql(query(), 10).text).not.toContain("count(distinct");
    expect(buildReportSql(query({ metrics: ["users"] }), 10).text).toContain("count(distinct user_id) as m_users");
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

// 묶음 목록(DESIGN 6.3 응답). 일광 절약 시간과 일부만 찬 묶음을 DB의 달력으로 만든다.
describe("buildBucketsSql", () => {
  const pool = createPool({ connectionString: inject("databaseUrl"), max: 1 });
  afterAll(() => pool.end());
  const buckets = async (patch: Record<string, unknown>) => {
    const q = query(patch);
    const { text, values } = buildBucketsSql(q);
    return toReportBuckets(q, (await pool.query(text, values)).rows);
  };

  it("뉴욕 2026-11-01 시간 묶음은 25개이고, 두 01:00은 오프셋(-04:00, -05:00)으로 가린다", async () => {
    const list = await buckets({ from: "2026-11-01", to: "2026-11-01", granularity: "hour", timezone: "America/New_York" });
    expect(list).toHaveLength(25);
    expect(list.filter((b) => b.label === "2026-11-01 01:00")).toEqual([
      { bucket: "2026-11-01T05:00:00.000Z", label: "2026-11-01 01:00", utcOffset: "-04:00", partial: false },
      { bucket: "2026-11-01T06:00:00.000Z", label: "2026-11-01 01:00", utcOffset: "-05:00", partial: false },
    ]);
  });

  it("뉴욕 2027-03-14 시간 묶음은 23개이고 02:00이 없다", async () => {
    const list = await buckets({ from: "2027-03-14", to: "2027-03-14", granularity: "hour", timezone: "America/New_York" });
    expect(list).toHaveLength(23);
    expect(list.map((b) => b.label)).not.toContain("2027-03-14 02:00");
  });

  it("수요일~다음 주 화요일의 주 묶음은 둘이고 둘 다 일부만 찼다", async () => {
    const list = await buckets({ from: "2026-10-28", to: "2026-11-03", granularity: "week" });
    expect(list).toEqual([
      { bucket: "2026-10-25T15:00:00.000Z", label: "2026-10-26", utcOffset: "+09:00", partial: true },
      { bucket: "2026-11-01T15:00:00.000Z", label: "2026-11-02", utcOffset: "+09:00", partial: true },
    ]);
  });

  it("일 묶음은 기간의 날짜마다 하나이고 일부만 찬 것이 없으며, total은 하나다(콜카타 +05:30)", async () => {
    const days = await buckets({ from: "2026-10-26", to: "2026-10-28", granularity: "day", timezone: "Asia/Kolkata" });
    expect(days.map((b) => [b.label, b.utcOffset, b.partial])).toEqual([
      ["2026-10-26", "+05:30", false],
      ["2026-10-27", "+05:30", false],
      ["2026-10-28", "+05:30", false],
    ]);
    expect(await buckets({ from: "2026-10-26", to: "2026-10-28", granularity: "total", timezone: "Asia/Kolkata" })).toEqual([
      { bucket: "2026-10-25T18:30:00.000Z", label: "2026-10-26 ~ 2026-10-28", utcOffset: "+05:30", partial: false },
    ]);
  });
});
