import { ApiError, ContractError, NetworkError } from "../api/client";
import styles from "./States.module.css";

// 읽는 중·실패 표시. 리포트의 422·503은 서버의 문장을 그대로 보이고, 503과 연결 끊김에는 다시 하기를 준다(DESIGN 6.7 알림).
export function Loading({ label = "세는 중…" }: { label?: string }) {
  return (
    <p className={styles.muted} role="status">
      {label}
    </p>
  );
}

// hint: 화면이 덧붙이는 안내(저장한 리포트의 기간이 보관 기간을 지났을 때 등)
export function LoadError({ error, onRetry, hint }: { error: unknown; onRetry: () => void; hint?: string | undefined }) {
  const retryable = error instanceof NetworkError || (error instanceof ApiError && error.status === 503);
  const message =
    error instanceof NetworkError
      ? "서버에 닿지 않습니다."
      : error instanceof ApiError
        ? (error.serverMessage ?? `요청이 실패했습니다(${error.status}).`)
        : error instanceof ContractError
          ? "응답을 읽지 못했습니다(화면과 서버의 계약이 다릅니다)."
          : "불러오지 못했습니다.";
  return (
    <div className={styles.error} role="alert">
      <p>{message}</p>
      {hint && <p>{hint}</p>}
      {retryable && (
        <button type="button" onClick={onRetry}>
          다시 하기
        </button>
      )}
    </div>
  );
}
