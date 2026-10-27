import { createHash, timingSafeEqual } from "node:crypto";
import { ErrorResponse, IngestBatch, IngestResult, IngestUnavailable as IngestUnavailableBody } from "@event-analytics/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type pg from "pg";
import { IngestUnavailable, ingest } from "../ingest.js";

// 본문 한도. 보통의 글자로 꽉 채운 이벤트(한 건 5.6KB쯤) 1,000건이 들어간다. 넘으면 413이고 나눠 보낸다(DESIGN 6.1).
export const INGEST_BODY_LIMIT = 6 * 1024 * 1024;

const digest = (value: string) => createHash("sha256").update(value).digest();

// POST /ingest. 쓰기 키는 본문을 읽기 전에 본다(DESIGN 10장 21).
export const ingestRoutes: FastifyPluginAsyncZod<{ pool: pg.Pool; writeKey: string }> = async (app, { pool, writeKey }) => {
  const expected = digest(writeKey);
  // 길이가 달라도 같은 시간이 걸리게 두 값의 SHA-256을 견준다.
  app.addHook("onRequest", async (request, reply) => {
    const given = request.headers["x-write-key"];
    if (typeof given !== "string" || !timingSafeEqual(digest(given), expected)) {
      return reply.code(401).send({ error: "쓰기 키가 없거나 틀립니다" });
    }
  });

  app.post(
    "/ingest",
    {
      bodyLimit: INGEST_BODY_LIMIT,
      schema: {
        body: IngestBatch,
        response: { 200: IngestResult, 401: ErrorResponse, 503: IngestUnavailableBody },
      },
    },
    async (request, reply) => {
      try {
        return await ingest(pool, request.body.events);
      } catch (err) {
        if (!(err instanceof IngestUnavailable)) throw err;
        request.log.warn({ err: err.cause }, `수집: ${err.code}`);
        return reply.code(503).send({ error: err.message, code: err.code });
      }
    },
  );
};
