import { ReportFailure, RetentionQuery, RetentionResult } from "@event-analytics/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type pg from "pg";
import { type RetentionOptions, runRetention } from "../reports/retention-run.js";
import { failureReply } from "../reports/transaction.js";

// POST /retention/query(DESIGN 6.5). 날마다 무리의 N일째 돌아온 사용자 수. 리포트와 같은 풀·한도·실패 코드다.
export const retentionRoutes: FastifyPluginAsyncZod<{ pool: pg.Pool; options?: RetentionOptions }> = async (app, { pool, options }) => {
  app.post(
    "/retention/query",
    { schema: { body: RetentionQuery, response: { 200: RetentionResult, 422: ReportFailure, 503: ReportFailure } } },
    async (request, reply) => {
      try {
        return await runRetention(pool, request.body, options);
      } catch (err) {
        const failed = failureReply(err);
        if (!failed) throw err;
        if (failed.status === 503) request.log.warn({ err: (err as Error).cause }, `리텐션: ${failed.body.code}`);
        return reply.code(failed.status).send(failed.body);
      }
    },
  );
};
