import { FunnelQuery, FunnelResult, ReportFailure } from "@event-analytics/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type pg from "pg";
import { type FunnelOptions, runFunnel } from "../reports/funnel-run.js";
import { failureReply } from "../reports/transaction.js";

// POST /funnels/query(DESIGN 6.5). 첫 진입 기준 전환의 단계별 사용자 수. 리포트와 같은 풀·한도·실패 코드다.
export const funnelRoutes: FastifyPluginAsyncZod<{ pool: pg.Pool; options?: FunnelOptions }> = async (app, { pool, options }) => {
  app.post(
    "/funnels/query",
    { schema: { body: FunnelQuery, response: { 200: FunnelResult, 422: ReportFailure, 503: ReportFailure } } },
    async (request, reply) => {
      try {
        return await runFunnel(pool, request.body, options);
      } catch (err) {
        const failed = failureReply(err);
        if (!failed) throw err;
        if (failed.status === 503) request.log.warn({ err: (err as Error).cause }, `퍼널: ${failed.body.code}`);
        return reply.code(failed.status).send(failed.body);
      }
    },
  );
};
