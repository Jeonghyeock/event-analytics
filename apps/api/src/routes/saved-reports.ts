import {
  SAVED_REPORT_CONFIGS,
  type SavedReport,
  SavedReportFailure,
  SavedReportInput,
  SavedReportItem,
  type SavedReportKind,
  SavedReportList,
  SavedReportParams,
} from "@event-analytics/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type pg from "pg";
import { z } from "zod";

// 저장한 리포트(DESIGN 6.7, 10장 52). 혼자 쓰는 로컬 도구라 마지막에 쓴 것이 남는다(버전·공유 없음).
// 짧은 쓰기라 수집과 같은 풀을 쓴다. 이름은 종류가 달라도 유일하다(겹치면 409).

type Row = { id: string; name: string; kind: SavedReportKind; config: unknown; created_at: Date; updated_at: Date };

const COLUMNS = "id, name, kind, config, created_at, updated_at";

// 열 때마다 지금의 스키마로 검사한다. 맞지 않으면 valid: false로 그대로 준다(목록 전체가 500이 되지 않게).
function toSavedReport(row: Row): SavedReport {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    config: row.config,
    valid: SAVED_REPORT_CONFIGS[row.kind].safeParse(row.config).success,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const nameTaken = (err: unknown) => (err as { code?: string }).code === "23505";
const NAME_TAKEN = { error: "같은 이름의 저장한 리포트가 있습니다. 다른 이름을 쓰거나 덮어쓰세요", code: "name_taken" as const };
const NOT_FOUND = { error: "저장한 리포트가 없습니다", code: "not_found" as const };

export const savedReportRoutes: FastifyPluginAsyncZod<{ pool: pg.Pool }> = async (app, { pool }) => {
  // 이름 순. 정렬은 builtin C.UTF-8의 코드 포인트 순서라 대문자가 먼저다. 그래서 lower(name)로 먼저 줄 세운다.
  app.get("/saved-reports", { schema: { response: { 200: SavedReportList } } }, async () => {
    const { rows } = await pool.query<Row>(`select ${COLUMNS} from saved_reports order by lower(name), name`);
    return { items: rows.map(toSavedReport) };
  });

  app.post(
    "/saved-reports",
    { schema: { body: SavedReportInput, response: { 201: SavedReportItem, 409: SavedReportFailure } } },
    async (request, reply) => {
      const { name, kind, config } = request.body;
      try {
        const { rows } = await pool.query<Row>(
          `insert into saved_reports (name, kind, config) values ($1, $2, $3) returning ${COLUMNS}`,
          [name, kind, JSON.stringify(config)],
        );
        return reply.code(201).send({ item: toSavedReport(rows[0]!) });
      } catch (err) {
        if (nameTaken(err)) return reply.code(409).send(NAME_TAKEN);
        throw err;
      }
    },
  );

  // 덮어쓰기(이름을 바꿔도 된다). 바뀐 시각은 now()다.
  app.put(
    "/saved-reports/:id",
    {
      schema: {
        params: SavedReportParams,
        body: SavedReportInput,
        response: { 200: SavedReportItem, 404: SavedReportFailure, 409: SavedReportFailure },
      },
    },
    async (request, reply) => {
      const { name, kind, config } = request.body;
      try {
        const { rows } = await pool.query<Row>(
          `update saved_reports set name = $2, kind = $3, config = $4, updated_at = now() where id = $1 returning ${COLUMNS}`,
          [request.params.id, name, kind, JSON.stringify(config)],
        );
        if (rows.length === 0) return reply.code(404).send(NOT_FOUND);
        return { item: toSavedReport(rows[0]!) };
      } catch (err) {
        if (nameTaken(err)) return reply.code(409).send(NAME_TAKEN);
        throw err;
      }
    },
  );

  app.delete(
    "/saved-reports/:id",
    { schema: { params: SavedReportParams, response: { 204: z.null(), 404: SavedReportFailure } } },
    async (request, reply) => {
      const { rowCount } = await pool.query("delete from saved_reports where id = $1", [request.params.id]);
      if (rowCount === 0) return reply.code(404).send(NOT_FOUND);
      return reply.code(204).send(null);
    },
  );
};
