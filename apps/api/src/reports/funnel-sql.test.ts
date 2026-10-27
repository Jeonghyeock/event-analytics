import { FunnelQuery, RetentionQuery } from "@event-analytics/shared";
import { afterAll, describe, expect, inject, it } from "vitest";
import { createPool } from "../db/pool.js";
import { buildFunnelSql, toFunnelRows } from "./funnel-sql.js";
import { buildCohortDaysSql, buildRetentionSql, toRetentionRows } from "./retention-sql.js";

// 퍼널·리텐션 SQL 만들기(DESIGN 6.5). 값이 SQL 글자에 들어가지 않는지, 정의의 조건이 SQL에 있는지, 만든 SQL이 실제로 도는지 본다.
// 손으로 센 값과의 비교는 경로 테스트에서 한다.
const funnel = (patch: Record<string, unknown> = {}) =>
  FunnelQuery.parse({ steps: ["performance_list_viewed", "seat_map_viewed", "seats_held"], windowMinutes: 30, from: "2026-10-20", to: "2026-10-26", ...patch });
const retention = (patch: Record<string, unknown> = {}) => RetentionQuery.parse({ days: 7, from: "2026-10-20", to: "2026-10-26", ...patch });
const windowEnd = new Date("2026-10-26T15:30:00Z");

describe("buildFunnelSql", () => {
  it("단계 이름·필터 값·날짜는 매개변수로만 가고, windowEnd도 매개변수다", () => {
    const evil = "x'); drop table events; --";
    const { text, values } = buildFunnelSql(funnel({ filters: [{ dimension: "campaign", values: [evil, null] }] }), windowEnd);
    expect(text).not.toContain(evil);
    expect(text).not.toContain("seat_map_viewed");
    expect(text).not.toContain("2026-10-20");
    expect(values).toEqual(["2026-10-20", "2026-10-26", "Asia/Seoul", 30, windowEnd, "performance_list_viewed", "seat_map_viewed", "seats_held", [evil]]);
    // 필터는 모든 단계(원본 e)에 건다: 1단계 + 2·3단계 조인
    expect(text.split("(e.campaign = any($9::text[]) or e.campaign is null)")).toHaveLength(4);
    expect(text).toContain("e.occurred_at < $5::timestamptz");
    expect(text).not.toContain("interval '");
  });

  it("k단계는 앞 단계보다 엄격히 뒤이고, 진입 + 전환 기간 앞이다", () => {
    const { text } = buildFunnelSql(funnel(), windowEnd);
    expect(text).toContain("e.occurred_at > s.t1 and e.occurred_at < s.t1 + make_interval(mins => $4::int)");
    expect(text).toContain("e.occurred_at > s.t and e.occurred_at < s.t1 + make_interval(mins => $4::int)");
    expect(text).toContain("min(e.occurred_at) as t1 from events e");
    expect(text).toContain("(select count(*)::int from s3) as n3");
  });

  it("나눔은 진입 이벤트의 값이고, 같은 밀리초는 event_id로 정한다", () => {
    const { text } = buildFunnelSql(funnel({ breakdown: ["channel"] }), windowEnd);
    expect(text).toContain("select distinct on (e.user_id) e.user_id, e.occurred_at as t1, e.channel as d0 from events e");
    expect(text).toContain("order by e.user_id, e.occurred_at, e.event_id");
    expect(text).toContain("group by s.user_id, s.t1, s.d0");
  });

  it("결과 행: 나눔이 없으면 한 행, 나눔이면 값마다 단계 수(빠진 단계는 0)", () => {
    expect(toFunnelRows(funnel(), [{ n1: 0, n2: 0, n3: 0 }])).toEqual([{ dimensions: {}, steps: [0, 0, 0] }]);
    const q = funnel({ breakdown: ["channel"] });
    expect(
      toFunnelRows(q, [
        { d0: "naver", step: 1, n: 5 },
        { d0: "naver", step: 2, n: 3 },
        { d0: null, step: 1, n: 2 },
      ]),
    ).toEqual([
      { dimensions: { channel: "naver" }, steps: [5, 3, 0] },
      { dimensions: { channel: null }, steps: [2, 0, 0] },
    ]);
  });
});

describe("buildRetentionSql", () => {
  it("돌아옴의 끝은 날짜 산술이고(변하지 않는 식), 이벤트 이름과 필터 값은 매개변수다", () => {
    const { text, values } = buildRetentionSql(
      retention({ startEvent: "seats_held", returnEvent: "payment_succeeded", filters: [{ dimension: "platform", values: ["ios"] }] }),
    );
    expect(text).toContain("e.occurred_at >= (($1::date + 1)::timestamp at time zone $3::text)");
    expect(text).toContain("e.occurred_at < (($2::date + 1 + $4::int)::timestamp at time zone $3::text)");
    expect(text).not.toContain("interval");
    expect(text).toContain("b.d - c.d between 1 and $4::int");
    expect(text).not.toContain("seats_held");
    expect(values).toEqual(["2026-10-20", "2026-10-26", "Asia/Seoul", 7, "seats_held", "payment_succeeded", ["ios"]]);
    // 필터는 시작과 돌아옴 모두에
    expect(text.split("e.platform = any($7::text[])")).toHaveLength(3);
  });

  it("이벤트 이름이 없으면 모든 이벤트다", () => {
    const { text, values } = buildRetentionSql(retention());
    expect(text).not.toContain("event_name");
    expect(values).toHaveLength(4);
  });

  it("결과 행: 기간의 모든 날, 무리 없는 날은 0, 다 지나지 않은 칸은 null", () => {
    const q = retention({ days: 3, from: "2026-10-24", to: "2026-10-26" });
    const days = ["2026-10-24", "2026-10-25", "2026-10-26"].map((cohort, i) => ({ cohort, start: new Date(Date.UTC(2026, 9, 23 + i, 15)) }));
    const counts = [
      { cohort: "2026-10-24", n: 0, users: 10 },
      { cohort: "2026-10-24", n: 2, users: 4 },
      { cohort: "2026-10-26", n: 0, users: 6 },
    ];
    // 오늘 10-27: 10-24의 1·2일째(10-25, 10-26)는 지났고, 3일째(10-27)는 오늘이라 모른다
    expect(toRetentionRows(q, days, counts, "2026-10-27")).toEqual([
      { cohort: "2026-10-24", cohortStart: "2026-10-23T15:00:00.000Z", users: 10, returned: [0, 4, null] },
      { cohort: "2026-10-25", cohortStart: "2026-10-24T15:00:00.000Z", users: 0, returned: [0, null, null] },
      { cohort: "2026-10-26", cohortStart: "2026-10-25T15:00:00.000Z", users: 6, returned: [null, null, null] },
    ]);
  });
});

describe("만든 SQL이 도는지", () => {
  const pool = createPool({ connectionString: inject("databaseUrl"), max: 1 });
  afterAll(() => pool.end());

  it.each([
    [{}],
    [{ breakdown: ["campaign"], filters: [{ dimension: "platform", values: ["ios", null] }] }],
    [{ steps: ["a", "a"], timezone: "America/New_York" }],
  ])("퍼널 %j", async (patch) => {
    const q = funnel(patch);
    const { text, values } = buildFunnelSql(q, windowEnd);
    const { rows } = await pool.query(text, values);
    // 나눔이 없으면 진입이 0이어도 한 행, 나눔이면 진입이 없는 값은 행이 없다
    const result = toFunnelRows(q, rows);
    if (q.breakdown.length === 0) expect(result).toHaveLength(1);
    expect(result.every((r) => r.steps.length === q.steps.length)).toBe(true);
  });

  it.each([[{}], [{ startEvent: "a", returnEvent: "b", filters: [{ dimension: "channel", values: [null] }], timezone: "Asia/Kolkata" }]])(
    "리텐션 %j",
    async (patch) => {
      const q = retention(patch);
      const { text, values } = buildRetentionSql(q);
      const counts = (await pool.query(text, values)).rows;
      const days = buildCohortDaysSql(q);
      const dayRows = (await pool.query(days.text, days.values)).rows;
      expect(toRetentionRows(q, dayRows, counts, "2026-10-27")).toHaveLength(7);
    },
  );
});
