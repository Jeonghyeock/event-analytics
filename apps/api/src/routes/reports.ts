import { ReportFailure, ReportQuery, ReportResult } from "@event-analytics/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type pg from "pg";
import { ReportFailed, type ReportOptions, runReport } from "../reports/run.js";

// POST /reports/query(DESIGN 6.3). 로그인은 없다(10장 8). 설정이 틀리면 400(스키마), 행이 너무 많으면 422, 시간 한도·DB가 바쁘면 503.
export const reportRoutes: FastifyPluginAsyncZod<{ pool: pg.Pool; options?: ReportOptions }> = async (app, { pool, options }) => {
  app.post(
    "/reports/query",
    { schema: { body: ReportQuery, response: { 200: ReportResult, 422: ReportFailure, 503: ReportFailure } } },
    async (request, reply) => {
      try {
        return await runReport(pool, request.body, options);
      } catch (err) {
        if (!(err instanceof ReportFailed)) throw err;
        if (err.code !== "too_many_rows") request.log.warn({ err: err.cause }, `리포트: ${err.code}`);
        return reply.code(err.code === "too_many_rows" ? 422 : 503).send({ error: err.message, code: err.code });
      }
    },
  );
};
