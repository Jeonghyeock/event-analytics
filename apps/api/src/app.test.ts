import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("GET /health", () => {
  const app = buildApp();
  afterAll(() => app.close());

  it("200과 status ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("없는 경로는 404", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
  });
});
