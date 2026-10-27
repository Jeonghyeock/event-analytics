import { FunnelQuery, FunnelResult, ReportQuery, ReportResult, RetentionQuery, RetentionResult } from "@event-analytics/shared";
import type { z } from "zod";
import { apiRequest } from "./client";

// 경로마다 하나. 보내기 전에 설정을 공유 스키마로 검사한다(틀린 설정을 서버의 400 전에 화면에서 막고, 기본값을 채운다).
// 그래서 받는 것은 기본값이 비어도 되는 입력 형이다. 검사 실패는 거절된 Promise다(async).
export const runReport = async (q: z.input<typeof ReportQuery>) =>
  apiRequest("/reports/query", { method: "POST", body: ReportQuery.parse(q), schema: ReportResult });

export const runFunnel = async (q: z.input<typeof FunnelQuery>) =>
  apiRequest("/funnels/query", { method: "POST", body: FunnelQuery.parse(q), schema: FunnelResult });

export const runRetention = async (q: z.input<typeof RetentionQuery>) =>
  apiRequest("/retention/query", { method: "POST", body: RetentionQuery.parse(q), schema: RetentionResult });
