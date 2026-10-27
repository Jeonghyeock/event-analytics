import { ReportQuery, type ReportResult } from "@event-analytics/shared";
import { describe, expect, it } from "vitest";
import { assignColors, axisLabels, bucketStates, buildChartData, buildTable, type ChartBucket, niceTicks, OTHER_KEY, seriesKey, seriesLabel } from "./series";

// 리포트 응답 → 그래프와 표(DESIGN 6.7, 10장 51·53).
const q = (patch: Record<string, unknown> = {}) =>
  ReportQuery.parse({ metrics: ["events"], granularity: "day", from: "2026-10-25", to: "2026-10-27", ...patch });

const day = (d: string) => ({ bucket: `2026-10-${d}T15:00:00.000Z`, label: `2026-10-${Number(d) + 1}`, utcOffset: "+09:00", partial: false });
// 한국 시각 10-25~10-27의 세 묶음. "지금"은 10-27 12:00 UTC(한국 시각 10-27 21:00): 10-27은 진행 중
const meta = (patch: Partial<ReportResult["meta"]> = {}): ReportResult["meta"] => ({
  timezone: "Asia/Seoul",
  rangeStart: "2026-10-24T15:00:00.000Z",
  rangeEnd: "2026-10-27T15:00:00.000Z",
  rowCount: 0,
  source: "raw",
  rollupWatermark: null,
  stale: false,
  provisional: true,
  asOf: "2026-10-27T12:00:00.000Z",
  buckets: [day("24"), day("25"), day("26")],
  ...patch,
});
const row = (bucketDay: string, dimensions: Record<string, string | null>, events?: number, users?: number) => ({
  bucket: `2026-10-${bucketDay}T15:00:00.000Z`,
  label: "",
  dimensions,
  ...(events !== undefined ? { events } : {}),
  ...(users !== undefined ? { users } : {}),
});

describe("bucketStates", () => {
  const states = (asOf: string, withRows?: Set<string>) => bucketStates(meta().buckets, meta({ asOf }), withRows).map((b) => b.state);

  it("다 센 묶음, \"지금\"이 든 묶음(진행 중), 아직 오지 않은 묶음을 가린다", () => {
    expect(states("2026-10-27T12:00:00.000Z")).toEqual(["done", "done", "current"]);
    expect(states("2026-10-25T16:00:00.000Z")).toEqual(["done", "current", "future"]);
  });

  it("아직 오지 않은 묶음에 행이 있으면(지금 + 1시간까지 받은 이벤트) 진행 중으로 그린다", () => {
    expect(states("2026-10-25T16:00:00.000Z", new Set([day("26").bucket]))).toEqual(["done", "current", "current"]);
  });

  it("미래 기간의 일부만 찬 첫 주는 기간 시작으로 견준다(\"진행 중\"이 아니라 아직)", () => {
    // 기간은 수요일(10-28 한국 시각)에 시작하고, 첫 주 묶음은 그 주 월요일(10-26)이다. "지금"은 10-27이다.
    const week = { bucket: "2026-10-25T15:00:00.000Z", label: "2026-10-26", utcOffset: "+09:00", partial: true };
    const future = meta({ asOf: "2026-10-27T12:00:00.000Z", rangeStart: "2026-10-27T15:00:00.000Z", rangeEnd: "2026-11-01T15:00:00.000Z" });
    expect(bucketStates([week], future)[0]!.state).toBe("future");
  });

  it("뉴욕 11-01의 두 01:00은 오프셋을 덧붙여 가린다", () => {
    const buckets = [
      { bucket: "2026-11-01T05:00:00.000Z", label: "2026-11-01 01:00", utcOffset: "-04:00", partial: false },
      { bucket: "2026-11-01T06:00:00.000Z", label: "2026-11-01 01:00", utcOffset: "-05:00", partial: false },
      { bucket: "2026-11-01T07:00:00.000Z", label: "2026-11-01 02:00", utcOffset: "-05:00", partial: false },
    ];
    const range = { asOf: "2026-12-01T00:00:00.000Z", rangeStart: "2026-11-01T04:00:00.000Z", rangeEnd: "2026-11-01T08:00:00.000Z" };
    expect(bucketStates(buckets, range).map((b) => b.label)).toEqual([
      "2026-11-01 01:00 (-04:00)",
      "2026-11-01 01:00 (-05:00)",
      "2026-11-01 02:00",
    ]);
  });
});

describe("계열의 키와 이름", () => {
  it("값이 없는 것은 \"(없음)\"이고, 글자 \"null\"과 키가 다르다", () => {
    const query = q({ dimensions: ["campaign"] });
    expect(seriesKey(query, { campaign: null })).not.toBe(seriesKey(query, { campaign: "null" }));
    expect(seriesLabel(query, { campaign: null })).toBe("(없음)");
  });

  it("차원 둘은 짝이다", () => {
    const query = q({ dimensions: ["platform", "campaign"] });
    expect(seriesLabel(query, { platform: "ios", campaign: null })).toBe("ios · (없음)");
  });
});

describe("buildChartData", () => {
  it("빈 묶음은 0, 아직 오지 않은 묶음은 null이다", () => {
    const result = { rows: [row("24", {}, 5)], meta: meta({ asOf: "2026-10-25T16:00:00.000Z" }) };
    expect(buildChartData(q(), result).series).toEqual([{ key: "[]", label: "전체", other: false, values: { events: [5, 0, null] } }]);
  });

  it("상위 N개 + 기타: 이벤트 수는 나머지를 더하고, 사용자 수는 기타가 없다", () => {
    const query = q({ metrics: ["events", "users"], dimensions: ["campaign"] });
    const rows = [
      row("24", { campaign: "a" }, 10, 3),
      row("24", { campaign: "b" }, 7, 3),
      row("24", { campaign: "c" }, 2, 2),
      row("25", { campaign: "c" }, 1, 1),
      row("24", { campaign: null }, 9, 4),
    ];
    const data = buildChartData(query, { rows, meta: meta() }, 2);
    // 순위: a(10) > (없음)(9) > b(7) > c(3). "(없음)"은 하나의 값이라 순위에 든다
    expect(data.series.map((s) => s.label)).toEqual(["a", "(없음)", "기타"]);
    const other = data.series.find((s) => s.key === OTHER_KEY)!;
    expect(other.values).toEqual({ events: [9, 1, 0] });
    expect(other.values.users).toBeUndefined();
    expect(data).toMatchObject({ rankedBy: "events", hidden: 2 });
  });

  it("사용자 수뿐이면 묶음별 사용자 수의 합으로 순위를 매기고 기타가 없다", () => {
    const query = q({ metrics: ["users"], dimensions: ["campaign"] });
    const rows = [row("24", { campaign: "a" }, undefined, 1), row("24", { campaign: "b" }, undefined, 5), row("25", { campaign: "a" }, undefined, 3)];
    const data = buildChartData(query, { rows, meta: meta() }, 1);
    expect(data.series.map((s) => s.label)).toEqual(["b"]);
    expect(data).toMatchObject({ rankedBy: "users", hidden: 1 });
  });
});

describe("buildTable", () => {
  it("일부만 찬 첫·끝 주와 진행 중인 묶음에 표시를 붙이고, 합계는 이벤트 수에만 둔다", () => {
    const query = q({ granularity: "week", from: "2026-10-21", to: "2026-10-27", metrics: ["events", "users"] });
    const weeks = [
      { bucket: "2026-10-18T15:00:00.000Z", label: "2026-10-19", utcOffset: "+09:00", partial: true },
      { bucket: "2026-10-25T15:00:00.000Z", label: "2026-10-26", utcOffset: "+09:00", partial: true },
    ];
    const rows = [
      { bucket: weeks[0]!.bucket, label: "2026-10-19", dimensions: {}, events: 4, users: 2 },
      { bucket: weeks[1]!.bucket, label: "2026-10-26", dimensions: {}, events: 3, users: 2 },
    ];
    const table = buildTable(query, { rows, meta: meta({ buckets: weeks, rangeStart: "2026-10-20T15:00:00.000Z" }) });
    expect(table.rows.map((r) => r.note)).toEqual(["일부(2026-10-21부터)", "일부(2026-10-27까지), 진행 중"]);
    expect(table.eventsTotal).toBe(7);
    expect(buildTable(q({ metrics: ["users"] }), { rows: [], meta: meta() }).eventsTotal).toBeNull();
  });

  it("묶음 하나뿐인 일부 주: 월요일에 시작하면 끝이 잘린 것이고, 주 가운데서 시작하면 기간 전체를 적는다", () => {
    const week = { bucket: "2026-10-25T15:00:00.000Z", label: "2026-10-26", utcOffset: "+09:00", partial: true };
    const rows = [{ bucket: week.bucket, label: "2026-10-26", dimensions: {}, events: 1 }];
    const note = (from: string, to: string, rangeStart: string) =>
      buildTable(q({ granularity: "week", from, to }), { rows, meta: meta({ buckets: [week], rangeStart, asOf: "2026-12-01T00:00:00.000Z" }) }).rows[0]!.note;
    // 월요일(10-26)~수요일: 묶음 = 기간 시작
    expect(note("2026-10-26", "2026-10-28", "2026-10-25T15:00:00.000Z")).toBe("일부(2026-10-28까지)");
    // 수요일(10-28)~금요일: 묶음이 기간 시작보다 앞
    expect(note("2026-10-28", "2026-10-30", "2026-10-27T15:00:00.000Z")).toBe("일부(2026-10-28~2026-10-30)");
  });
});

describe("뉴욕 일광 절약 시간이 끝나는 날", () => {
  it("두 01:00의 값은 순간을 키로 따로 선다", () => {
    const buckets = [
      { bucket: "2026-11-01T05:00:00.000Z", label: "2026-11-01 01:00", utcOffset: "-04:00", partial: false },
      { bucket: "2026-11-01T06:00:00.000Z", label: "2026-11-01 01:00", utcOffset: "-05:00", partial: false },
    ];
    const rows = [
      { bucket: buckets[0]!.bucket, label: "2026-11-01 01:00", dimensions: {}, events: 5 },
      { bucket: buckets[1]!.bucket, label: "2026-11-01 01:00", dimensions: {}, events: 7 },
    ];
    const range = { rangeStart: "2026-11-01T05:00:00.000Z", rangeEnd: "2026-11-01T07:00:00.000Z", asOf: "2026-12-01T00:00:00.000Z" };
    const data = buildChartData(q({ granularity: "hour", timezone: "America/New_York" }), { rows, meta: meta({ buckets, ...range }) });
    expect(data.series[0]!.values.events).toEqual([5, 7]);
    expect(data.buckets.map((b) => b.label)).toEqual(["2026-11-01 01:00 (-04:00)", "2026-11-01 01:00 (-05:00)"]);
  });
});

describe("assignColors", () => {
  it("색은 계열을 따라간다: 남은 계열은 칸을 지키고, 새 계열은 빈 칸을 받으며, 기타는 칸이 없다", () => {
    const first = assignColors(["a", "b", "c"], new Map());
    expect([...first]).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    // b가 빠지고 d가 들어와도 a·c는 그대로다
    const second = assignColors(["c", "d", "a", OTHER_KEY], first);
    expect(second.get("a")).toBe(1);
    expect(second.get("c")).toBe(3);
    expect(second.get("d")).toBe(2);
    expect(second.has(OTHER_KEY)).toBe(false);
  });
});

describe("niceTicks", () => {
  it("0부터 깔끔한 정수로 최댓값을 덮는다(셈이라 소수 눈금이 없다)", () => {
    expect(niceTicks(9)).toEqual([0, 5, 10]);
    expect(niceTicks(1234)).toEqual([0, 500, 1000, 1500]);
    expect(niceTicks(100)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(2)).toEqual([0, 1, 2]);
    expect(niceTicks(1)).toEqual([0, 1]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

describe("axisLabels", () => {
  const hours = (days: string[], hoursPerDay = 24): ChartBucket[] =>
    days.flatMap((d) =>
      Array.from({ length: hoursPerDay }, (_, h) => ({
        bucket: `${d}T${String(h).padStart(2, "0")}:00:00.000Z`,
        label: `${d} ${String(h).padStart(2, "0")}:00`,
        state: "done" as const,
        partial: false,
      })),
    );

  it("시간 단위가 여러 날이면 자정에만 날짜를 적는다(연도를 뗌)", () => {
    expect(axisLabels(hours(["2026-10-20", "2026-10-21", "2026-10-22"]), 1000).map((l) => l.text)).toEqual(["10-20", "10-21", "10-22"]);
  });

  it("시간 단위가 하루뿐이면 시각만 적고, 좁으면 건너뛴다", () => {
    const labels = axisLabels(hours(["2026-10-20"]), 300);
    expect(labels[0]).toEqual({ index: 0, text: "00:00" });
    expect(labels.length).toBeLessThan(24);
  });

  it("해를 넘기면 연도를 둔다, 같은 label이 둘인 묶음(두 01:00)은 적지 않는다", () => {
    const days = (labels: string[]): ChartBucket[] => labels.map((label, i) => ({ bucket: String(i), label, state: "done", partial: false }));
    expect(axisLabels(days(["2026-12-31", "2027-01-01"]), 1000).map((l) => l.text)).toEqual(["2026-12-31", "2027-01-01"]);
    expect(axisLabels(days(["2026-11-01 00:00", "2026-11-01 01:00 (-04:00)", "2026-11-01 01:00 (-05:00)"]), 1000).map((l) => l.text)).toEqual(["00:00"]);
  });
});
