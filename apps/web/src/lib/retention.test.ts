import type { RetentionResult } from "@event-analytics/shared";
import { describe, expect, it } from "vitest";
import { retentionRows } from "./retention";

// 리텐션 응답 → 표(DESIGN 6.7).
describe("리텐션", () => {
  const meta: RetentionResult["meta"] = {
    timezone: "Asia/Seoul",
    rangeStart: "2026-10-24T15:00:00.000Z",
    rangeEnd: "2026-10-28T15:00:00.000Z",
    days: 2,
    today: "2026-10-27",
    provisional: true,
  };

  it("아직 지나지 않은 칸은 pending, 0명인 무리의 비율은 zero, 오늘의 무리는 진행 중, 오지 않은 날의 무리는 뺀다", () => {
    const rows = retentionRows({
      rows: [
        { cohort: "2026-10-25", cohortStart: "2026-10-24T15:00:00.000Z", users: 10, returned: [4, null] },
        { cohort: "2026-10-26", cohortStart: "2026-10-25T15:00:00.000Z", users: 0, returned: [0, null] },
        { cohort: "2026-10-27", cohortStart: "2026-10-26T15:00:00.000Z", users: 3, returned: [null, null] },
        { cohort: "2026-10-28", cohortStart: "2026-10-27T15:00:00.000Z", users: null, returned: [null, null] },
      ],
      meta,
    });
    expect(rows.map((r) => [r.cohort, r.current, r.cells.map((c) => c.state)])).toEqual([
      ["2026-10-25", false, ["known", "pending"]],
      ["2026-10-26", false, ["zero", "pending"]],
      ["2026-10-27", true, ["pending", "pending"]],
    ]);
    expect(rows[0]!.cells[0]).toEqual({ count: 4, rate: 0.4, state: "known" });
  });
});
