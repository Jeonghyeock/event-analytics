import { randomBytes } from "node:crypto";
import { HealthResponse, HealthUnavailable } from "@event-analytics/shared";
import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type pg from "pg";
import { ingestRoutes } from "./routes/ingest.js";

// 요청은 packages/shared의 zod 스키마로 검증하고, 응답도 같은 스키마로 직렬화한다.
// ingestWriteKey를 넘기지 않으면 무작위 키를 만든다. 아무도 모르는 키라 수집은 모두 401이다(안전한 기본값).
export function buildApp(pool: pg.Pool, options: FastifyServerOptions = {}, services: { ingestWriteKey?: string } = {}) {
  const app = Fastify(options).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // 풀에서 쉬는 연결이 끊기면(DB 재시작, pg_terminate_backend) 풀이 'error'를 낸다. 듣는 쪽이 없으면 프로세스가 죽는다.
  // 끊긴 연결은 풀이 버리고 다음 요청에 새로 맺으므로 로그만 남긴다.
  pool.on("error", (err) => app.log.error({ err }, "풀의 쉬는 연결이 끊김"));

  // 5xx는 오류 내용을 로그에만 남기고 응답에는 싣지 않는다(SQL 문장과 파라미터가 들어 있을 수 있다).
  // 4xx(요청 검증 실패 등)는 무엇이 틀렸는지 알려 준다.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: err.message });
    request.log.error({ err }, "처리하지 못한 오류");
    return reply.code(500).send({ error: "서버 오류" });
  });

  // DB에 닿지 않으면 503이다. pg 오류 내용(role 이름 등)은 응답에 싣지 않고 로그에만 남긴다.
  app.get(
    "/health",
    { schema: { response: { 200: HealthResponse, 503: HealthUnavailable } } },
    async (request, reply) => {
      try {
        await pool.query("select 1");
        return { status: "ok" as const };
      } catch (err) {
        request.log.error({ err }, "health: DB에 닿지 않음");
        return reply.code(503).send({ status: "unavailable" as const });
      }
    },
  );

  app.register(ingestRoutes, { pool, writeKey: services.ingestWriteKey ?? randomBytes(32).toString("hex") });

  return app;
}
