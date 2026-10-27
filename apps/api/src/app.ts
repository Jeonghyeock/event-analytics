import { HealthResponse } from "@event-analytics/shared";
import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";

// 요청은 packages/shared의 zod 스키마로 검증하고, 응답도 같은 스키마로 직렬화한다.
export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // 5xx는 오류 내용을 로그에만 남기고 응답에는 싣지 않는다(SQL 문장과 파라미터가 들어 있을 수 있다).
  // 4xx(요청 검증 실패 등)는 무엇이 틀렸는지 알려 준다.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: err.message });
    request.log.error({ err }, "처리하지 못한 오류");
    return reply.code(500).send({ error: "서버 오류" });
  });

  app.get("/health", { schema: { response: { 200: HealthResponse } } }, async () => ({ status: "ok" as const }));

  return app;
}
