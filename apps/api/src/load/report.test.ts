import { describe, expect, it } from "vitest";
import { crossesUtcHour, diffStats, type K6Event, percentile, runProblems, steadyWindow, summarizeKinds, totalDropped } from "./report.js";
import type { StatsSnapshot } from "./samplers.js";

// 측정 요약(DESIGN 6.8 "지표", "판단 규칙"). 판단을 정하는 계산이라 손으로 센 값으로 지킨다.
const report = (key: string, startedAt: number, ms: number, extra: Partial<Extract<K6Event, { ev: "report" }>> = {}): K6Event => ({
  ev: "report",
  vu: 1,
  key,
  warm: false,
  startedAt,
  ms,
  status: 200,
  code: null,
  poolMs: 0,
  ...extra,
});

describe("정상 구간", () => {
  it("닫힌 모형은 모든 VU가 예열을 마친 때부터 마지막 요청이 끝난 때까지다. 예열을 못 마친 VU가 있으면 null", () => {
    const events: K6Event[] = [
      report("r1", 1_000, 100, { warm: true }),
      { ev: "warmed", vu: 1, at: 2_000 },
      { ev: "warmed", vu: 2, at: 3_000 },
      report("r1", 3_500, 400),
    ];
    expect(steadyWindow(events, { vus: 2 })).toEqual({ start: 3_000, end: 3_900 });
    expect(steadyWindow(events, { vus: 3 })).toBeNull();
  });

  it("열린 모형은 첫 요청 + 예열 시간부터다", () => {
    expect(steadyWindow([report("r1", 10_000, 50), report("r2", 70_000, 50)], { openWarmupMs: 60_000 })).toEqual({ start: 70_000, end: 70_050 });
  });

  it("UTC 정시를 넘는지", () => {
    const hour = Date.parse("2026-10-28T05:00:00Z");
    expect(crossesUtcHour({ start: hour - 60_000, end: hour - 1 })).toBe(false);
    expect(crossesUtcHour({ start: hour - 60_000, end: hour + 1 })).toBe(true);
  });
});

describe("종류별 요약과 기다린 시간의 몫", () => {
  const window = { start: 0, end: 100_000 };

  it("p95는 성공한 요청만, 503은 비율과 걸린 시간으로 따로 적고, 5%를 넘으면 한도 이상이다", () => {
    const events: K6Event[] = [
      ...Array.from({ length: 19 }, (_, i) => report("r6", i * 1000, 1000 + i * 100)),
      report("r6", 50_000, 30_000, { status: 503, code: "report_timeout" }),
    ];
    const [r6] = summarizeKinds(events, window, ["r6"]).kinds;
    expect(r6).toMatchObject({ n: 20, ok: 19, p95: 2800, rate503: 0.05, overLimit: false, mean503Ms: 30_000, codes: { "503:report_timeout": 1 } });
    const more = summarizeKinds([...events, report("r6", 60_000, 5_000, { status: 503, code: "busy" })], window, ["r6"]).kinds[0]!;
    expect(more.overLimit).toBe(true);
  });

  it("예열과 구간 밖의 요청은 세지 않는다", () => {
    const events = [report("r1", 10, 5, { warm: true }), report("r1", 200_000, 5), report("r1", 50, 7)];
    expect(summarizeKinds(events, window, ["r1"]).kinds[0]).toMatchObject({ n: 1, p95: 7 });
  });

  it("풀 대기는 실행 시간(연결을 쥔 시간)의 비율로 나눠 몫에 더한다. 503까지 기다린 시간도 넣는다", () => {
    // r6: 실행 900(풀 대기 100), r1: 실행 100(풀 대기 300), r1의 503: 실행 0, 풀 대기 5000(연결을 못 받음)
    const events = [
      report("r6", 1, 1000, { poolMs: 100 }),
      report("r1", 2, 400, { poolMs: 300 }),
      report("r1", 3, 5000, { poolMs: 5000, status: 503, code: "busy" }),
    ];
    const summary = summarizeKinds(events, window, ["r1", "r6"]);
    expect(summary.poolMs).toBe(5400);
    const [r1, r6] = summary.kinds;
    // 실행 합 1000 = r1 100 + r6 900. 풀 대기 5400을 1:9로 나눈다.
    expect(r1).toMatchObject({ ownMs: 100, attributedPoolMs: 540, score: 640, totalMs: 5400 });
    expect(r6).toMatchObject({ ownMs: 900, attributedPoolMs: 4860, score: 5760 });
    expect(r1!.share + r6!.share).toBeCloseTo(1, 2);
    expect(r6!.share).toBe(0.9);
  });

  it("백분위는 가장 가까운 순위다", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
  });
});

describe("무효 조건", () => {
  const base = {
    dropped: 0,
    k6PctMax: 100,
    k6Cores: 8,
    othersPctMean: 150,
    othersBaseline: 60,
    otherCommits: 0,
    databasesChanged: [],
    vacuumOrAnalyze: 0,
  };

  it("버린 반복, k6 CPU, 다른 프로세스, 다른 DB의 커밋·생기거나 사라진 DB, 측정 DB의 vacuum·analyze, 체크포인트, 짧은 정상 구간", () => {
    expect(runProblems(base)).toEqual([]);
    expect(
      runProblems({
        ...base,
        dropped: 3,
        k6PctMax: 720,
        othersPctMean: 300,
        otherCommits: 2,
        databasesChanged: ["-event_analytics_x_1"],
        vacuumOrAnalyze: 1,
        checkpoints: 1,
        steady: { seconds: 1000, requested: 1200 },
      }),
    ).toEqual([
      "버린 반복 3",
      "k6 CPU 최대 720%(코어 8개)",
      "다른 프로세스 CPU 평균 300%(측정 전 60%)",
      "다른 DB의 커밋 2",
      "측정 중에 생기거나 사라진 DB(-event_analytics_x_1)",
      "체크포인트 1",
      "정상 구간 1000초(요청 1200초)",
      "측정 DB에 vacuum·analyze 1",
    ]);
  });

  it("k6 요약이 없거나 CPU 기준선이 없거나 높으면 무효다(검사가 조용히 꺼지지 않게)", () => {
    expect(runProblems({ ...base, dropped: null, othersBaseline: null })).toEqual(["k6 요약 없음", "CPU 기준선 표본 없음"]);
    expect(runProblems({ ...base, othersBaseline: 180, othersPctMean: 200 })).toEqual([]);
    expect(runProblems({ ...base, othersBaseline: 320, othersPctMean: 330 })).toEqual(["측정 전 다른 프로세스 CPU 320%"]);
  });

  it("다른 DB의 커밋은 DB마다 센다: 측정 중에 지워진 DB가 합을 음수로 만들어 검사를 지나치지 않게(코드 리뷰 재현)", () => {
    const snapshot = (otherCommits: Record<string, number>) =>
      ({
        at: "",
        tables: [],
        database: {},
        otherCommits,
        wal: {},
        checkpointer: { num_done: 0 },
        progress: { vacuums: 0, analyzes: 0 },
      }) as unknown as StatsSnapshot;
    const diff = diffStats(snapshot({ postgres: 10, test_db: 200 }), snapshot({ postgres: 10 }));
    expect(diff.otherCommits).toBe(0);
    expect(diff.databasesChanged).toEqual(["-test_db"]);
    expect(diffStats(snapshot({ postgres: 10 }), snapshot({ postgres: 13, fresh: 5 }))).toMatchObject({ otherCommits: 3, databasesChanged: ["+fresh"] });
  });

  it("버린 반복은 모든 시나리오(열린 모형의 리포트 포함)에서 더한다", () => {
    const summary = {
      metrics: {
        "dropped_iterations{scenario:background}": { values: { count: 1 } },
        "dropped_iterations{scenario:open_r6}": { values: { count: 2 } },
        "http_reqs{scenario:background}": { values: { count: 99 } },
      },
    };
    expect(totalDropped(summary)).toBe(3);
    expect(totalDropped(null)).toBeNull();
  });
});
