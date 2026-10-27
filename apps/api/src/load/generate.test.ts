import { IngestEvent } from "@event-analytics/shared";
import pg from "pg";
import { describe, expect, it, onTestFinished } from "vitest";
import { freshDatabase } from "../../test/fresh-database.js";
import { createDailyPartitions } from "../db/partitions.js";
import { insertEvents } from "../ingest.js";
import { FUNNEL, generate } from "./generate.js";

// 이벤트 생성기(DESIGN 6.2, 10장 29). 분포는 실제와 같다고 주장하지 않는다. 정해진 모양이 나오는지와 재실행이 안전한지만 본다.
const from = new Date("2026-10-01T00:00:00Z");
const to = new Date("2026-10-08T00:00:00Z");
const sample = (seed: number, events: number) => [...generate({ seed, events, from, to })];

describe("생성기", () => {
  const events = sample(1, 50_000);

  it("같은 씨앗이면 같은 이벤트(id까지)이고, 씨앗이 다르면 다르다", () => {
    expect(sample(1, 2_000)).toEqual(events.slice(0, 2_000));
    expect(sample(2, 10)).not.toEqual(events.slice(0, 10));
  });

  it("정확히 그 수만큼, 범위 안의 시각으로, 수집 스키마를 통과하는 이벤트를 만들고 id는 겹치지 않는다", () => {
    expect(events).toHaveLength(50_000);
    expect(events.every((e) => IngestEvent.safeParse(e).success)).toBe(true);
    expect(events.every((e) => e.occurredAt >= from.toISOString() && e.occurredAt < to.toISOString())).toBe(true);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(50_000);
  });

  it("예매 흐름의 단계마다 정한 비율로 줄어든다", () => {
    const counts = FUNNEL.map(([name]) => events.filter((e) => e.eventName === name).length);
    for (let i = 1; i < FUNNEL.length; i++) {
      expect(counts[i]! / counts[i - 1]!).toBeCloseTo(FUNNEL[i]![1], 1);
    }
  });

  it("캠페인은 소수가 대부분을 차지하고(zipf), 한국 시각 저녁이 새벽보다 많다", () => {
    const byCampaign = new Map<string, number>();
    for (const e of events) if (e.campaign) byCampaign.set(e.campaign, (byCampaign.get(e.campaign) ?? 0) + 1);
    const sorted = [...byCampaign.values()].sort((a, b) => b - a);
    const total = sorted.reduce((a, b) => a + b, 0);
    // 200개 가운데 상위 10개가 3분의 1 남짓을 차지한다(s = 1)
    expect(sorted.slice(0, 10).reduce((a, b) => a + b, 0) / total).toBeGreaterThan(0.3);
    expect(events.filter((e) => e.channel === "organic").every((e) => e.campaign === undefined)).toBe(true);

    const kstHour = (e: IngestEvent) => (new Date(e.occurredAt).getUTCHours() + 9) % 24;
    const at = (h: number) => events.filter((e) => kstHour(e) === h).length;
    expect(at(20)).toBeGreaterThan(at(4) * 5);
  });

  it("DB에 바로 넣고, 같은 씨앗으로 다시 넣으면 모두 중복이다", async () => {
    const db = await freshDatabase("gen");
    const client = new pg.Client({ connectionString: db.owner });
    await client.connect();
    onTestFinished(() => client.end());
    await createDailyPartitions(client, "2026-10-01", "2026-10-07", { retryDelaysMs: [] });
    const rows = events.slice(0, 3_000).map((e) => ({ ...e, at: Date.parse(e.occurredAt) }));
    expect(await insertEvents(client, rows)).toBe(3_000);
    expect(await insertEvents(client, rows)).toBe(0);
  });
});
