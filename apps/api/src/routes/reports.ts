import { ReportFailure, ReportQuery, ReportResult } from "@event-analytics/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type pg from "pg";
import { type ReportOptions, runReport } from "../reports/run.js";
import { ReportFailed } from "../reports/transaction.js";

// POST /reports/query(DESIGN 6.3). 로그인은 없다(10장 8). 설정이 틀리면 400(스키마), 행이 너무 많거나 보관 기간 밖이면 422,
// 시간 한도·DB가 바쁘면 503. pool은 리포트 전용 풀이다(느린 리포트가 수집의 연결을 빼앗지 않게, 10장 35).
export const reportRoutes: FastifyPluginAsyncZod<{ pool: pg.Pool; options?: ReportOptions }> = async (app, { pool, options }) => {
  app.post(
    "/reports/query",
    { schema: { body: ReportQuery, response: { 200: ReportResult, 422: ReportFailure, 503: ReportFailure } } },
    async (request, reply) => {
      try {
        return await runReport(pool, request.body, options);
      } catch (err) {
        if (!(err instanceof ReportFailed)) throw err;
        const status = err.code === "too_many_rows" || err.code === "out_of_retention" ? 422 : 503;
        if (status === 503) request.log.warn({ err: err.cause }, `리포트: ${err.code}`);
        return reply.code(status).send({ error: err.message, code: err.code });
      }
    },
  );
};
