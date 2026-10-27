import { SAVED_REPORT_CONFIGS, type SavedReport, type SavedReportKind } from "@event-analytics/shared";
import { hashKey, useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { z } from "zod";
import { ApiError } from "./client";
import { listSavedReports } from "./endpoints";

// 저장한 리포트(DESIGN 6.7, 10장 52). 목록은 캐시 하나(왼쪽 목록과 화면이 함께 쓴다). 저장·지우기는 이 키를 다시 읽게 한다.
export const SAVED_KEY = ["saved-reports"] as const;

export const useSavedReports = () => useQuery({ queryKey: SAVED_KEY, queryFn: listSavedReports });

// 종류마다 여는 화면. 리텐션은 /retention이다(복수형이 아니다).
export const SAVED_PATHS: Record<SavedReportKind, string> = { report: "/reports", funnel: "/funnels", retention: "/retention" };
export const KIND_LABELS: Record<SavedReportKind, string> = { report: "리포트", funnel: "퍼널", retention: "리텐션" };
// 조사까지 붙인 것("같은 이름의 퍼널이 있습니다")
export const KIND_SUBJECTS: Record<SavedReportKind, string> = { report: "리포트가", funnel: "퍼널이", retention: "리텐션이" };

export const savedPath = (kind: SavedReportKind, id: string) => `${SAVED_PATHS[kind]}?saved=${id}`;

export type ConfigOf<K extends SavedReportKind> = z.output<(typeof SAVED_REPORT_CONFIGS)[K]>;
export type OpenedReport<K extends SavedReportKind> = { item: SavedReport; config: ConfigOf<K> };

// ?saved=id로 연 화면의 상태. 열 때 지금의 스키마로 다시 검사한다: 서버의 valid와 화면의 검사가 모두 맞아야 연다.
export type SavedGateState<K extends SavedReportKind> =
  | { state: "new" }
  | { state: "loading" }
  | { state: "listError"; error: unknown }
  | { state: "missing" }
  | { state: "otherKind"; item: SavedReport }
  | { state: "invalid"; item: SavedReport }
  | ({ state: "open" } & OpenedReport<K>);

export function savedGateState<K extends SavedReportKind>(
  kind: K,
  savedId: string | null,
  list: { status: "pending" | "error" | "success"; error: unknown; data?: { items: SavedReport[] } | undefined },
): SavedGateState<K> {
  if (savedId === null) return { state: "new" };
  if (list.status === "pending") return { state: "loading" };
  if (list.status === "error") return { state: "listError", error: list.error };
  const item = list.data?.items.find((i) => i.id === savedId);
  if (!item) return { state: "missing" };
  if (item.kind !== kind) return { state: "otherKind", item };
  const parsed = SAVED_REPORT_CONFIGS[kind].safeParse(item.config);
  if (!item.valid || !parsed.success) return { state: "invalid", item };
  // kind의 스키마로 검사했으니 그 kind의 설정이다(TS가 인덱스로 고른 스키마의 출력을 좁히지 못한다)
  return { state: "open", item, config: parsed.data as ConfigOf<K> };
}

// 저장한 기간은 날짜 그대로라 90일이 지나면 422 out_of_retention이다. 연 리포트를 저장한 설정 그대로 셀 때만 날짜를 고치라고 덧붙인다
// (날짜를 고친 뒤의 422는 저장한 기간 탓이 아니다).
export function savedErrorHint<K extends SavedReportKind>(opened: OpenedReport<K> | null, requested: ConfigOf<K> | null, error: unknown) {
  if (!opened || requested === null || hashKey([requested]) !== hashKey([opened.config])) return undefined;
  if (!(error instanceof ApiError && error.code === "out_of_retention")) return undefined;
  return '저장한 기간이 보관 기간을 지났습니다. 위에서 날짜를 고친 뒤 "보기"를 누르세요.';
}

// 저장·지우기의 알림. 화면은 저장·지우기 뒤 새로 붙으므로(key) 알림은 그 바깥(SavedGate)이 들고 있다.
// for: 알림이 맞는 저장한 리포트의 id(지운 뒤의 새 화면은 null). 다른 것을 열면 알림은 사라진다.
export type SavedNotice = { for: string | null; text: string };
export const SavedNoticeContext = createContext<{
  notice: SavedNotice | null;
  // focus: 화면이 새로 붙은 뒤 제목으로 포커스를 옮긴다(누른 단추가 사라지므로)
  notify: (notice: SavedNotice, options?: { focus?: boolean }) => void;
}>({ notice: null, notify: () => {} });
export const useSavedNotice = () => useContext(SavedNoticeContext);
