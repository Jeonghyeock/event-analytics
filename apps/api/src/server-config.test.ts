import { describe, expect, it } from "vitest";
import { loadServerConfig } from "./server-config.js";

describe("서버 설정", () => {
  it("주지 않으면 지금까지의 값(풀 10, 리포트 풀 4, 로그 info, 1초 지표 끔)이다", () => {
    expect(loadServerConfig({})).toEqual({ poolMax: 10, reportPoolMax: 4, logLevel: "info", loadStatsDir: null });
  });

  it("부하 측정이 풀 크기·로그 수준·1초 지표 폴더를 준다", () => {
    expect(loadServerConfig({ DB_POOL_MAX: "20", REPORT_POOL_MAX: "8", LOG_LEVEL: "warn", LOAD_STATS: "load/results/x/api" })).toEqual({
      poolMax: 20,
      reportPoolMax: 8,
      logLevel: "warn",
      loadStatsDir: "load/results/x/api",
    });
  });

  it("틀린 값은 뜨지 않게 거절한다. 수는 숫자 글자만 받는다(16진수·지수·공백·빈 값 아님)", () => {
    for (const value of ["0", "열", "0x10", "1e1", " 10 ", "", "2.5", "101"]) {
      expect(() => loadServerConfig({ REPORT_POOL_MAX: value }), value).toThrow(/REPORT_POOL_MAX/);
    }
    expect(() => loadServerConfig({ DB_POOL_MAX: "열" })).toThrow(/DB_POOL_MAX/);
    expect(() => loadServerConfig({ LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
  });

  it("1초 지표 폴더가 빈 값이나 공백이면 끈다. 로그 수준 silent도 받는다", () => {
    expect(loadServerConfig({ LOAD_STATS: "" }).loadStatsDir).toBeNull();
    expect(loadServerConfig({ LOAD_STATS: "   " }).loadStatsDir).toBeNull();
    expect(loadServerConfig({ LOG_LEVEL: "silent" }).logLevel).toBe("silent");
  });
});
