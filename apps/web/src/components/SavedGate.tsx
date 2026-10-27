import type { SavedReport, SavedReportKind } from "@event-analytics/shared";
import { Fragment, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { KIND_LABELS, type OpenedReport, type SavedNotice, SavedNoticeContext, savedGateState, savedPath, useSavedReports } from "../api/saved";
import { DeleteSaved } from "./SaveControls";
import styles from "./Saved.module.css";
import { LoadError, Loading } from "./States";

// 화면(리포트·퍼널·리텐션)의 틀: ?saved=id면 저장한 리포트를 찾아 다시 검사한 뒤 연다(DESIGN 6.7, 10장 52).
// 화면은 key로 새로 붙는다: 다른 저장한 리포트를 열거나 목록에서 같은 것을 다시 누르면(새 이동) 양식과 결과가 저장한 설정으로 채워진다.
// 저장·지우기의 알림과 그 뒤의 포커스는 새로 붙는 화면 바깥인 여기서 맡는다.
export function SavedGate<K extends SavedReportKind>({
  kind,
  title,
  children,
}: {
  kind: K;
  title: string;
  children: (opened: OpenedReport<K> | null) => ReactNode;
}) {
  const [params] = useSearchParams();
  const location = useLocation();
  const savedId = params.get("saved");
  const list = useSavedReports();
  const gate = savedGateState(kind, savedId, list);

  const heading = useRef<HTMLHeadingElement>(null);
  const [notice, setNotice] = useState<SavedNotice | null>(null);
  const focusPending = useRef(false);
  // 다른 것을 열면(저장·지우기로 옮겨 온 것이 아니면) 알림을 지운다(렌더 중에 상태를 맞추는 React의 방법)
  const [shownFor, setShownFor] = useState(savedId);
  if (shownFor !== savedId) {
    setShownFor(savedId);
    if (notice && notice.for !== savedId) setNotice(null);
  }
  const current = notice && notice.for === savedId ? notice : null;
  // 알림이 그려진 그 커밋에서(칠하기 전에) 옮긴다
  useLayoutEffect(() => {
    if (focusPending.current && current) {
      focusPending.current = false;
      heading.current?.focus();
    }
  }, [current]);
  const notify = (next: SavedNotice, options?: { focus?: boolean }) => {
    focusPending.current = options?.focus ?? false;
    setNotice(next);
  };

  return (
    <SavedNoticeContext value={{ notice: current, notify }}>
      <h1 ref={heading} tabIndex={-1}>
        {title}
      </h1>
      {/* 늘 있는 알림 자리(화면 읽기 프로그램은 처음부터 있던 자리의 바뀐 글만 읽는다) */}
      <p className="visually-hidden" role="status">
        {current?.text}
      </p>
      {gate.state === "loading" ? (
        <Loading label="저장한 리포트를 읽는 중…" />
      ) : gate.state === "listError" ? (
        <LoadError error={gate.error} onRetry={() => void list.refetch()} />
      ) : gate.state === "invalid" ? (
        <InvalidSaved item={gate.item} />
      ) : (
        <>
          {gate.state === "missing" && <p className={styles.notice}>저장한 리포트를 찾을 수 없습니다(지워졌을 수 있습니다). 새로 설정하세요.</p>}
          {gate.state === "otherKind" && (
            <p className={styles.notice}>
              "{gate.item.name}"은(는) {KIND_LABELS[gate.item.kind]} 화면에서 엽니다.{" "}
              <Link to={savedPath(gate.item.kind, gate.item.id)}>{KIND_LABELS[gate.item.kind]} 화면에서 열기</Link>
            </p>
          )}
          <Fragment key={gate.state === "open" ? `${gate.item.id}:${location.key}` : "new"}>
            {children(gate.state === "open" ? { item: gate.item, config: gate.config } : null)}
          </Fragment>
        </>
      )}
    </SavedNoticeContext>
  );
}

// 지금의 스키마에 맞지 않는 옛 설정: 열지 않고 내용(읽기 전용)을 보이며 지우기만 할 수 있다
function InvalidSaved({ item }: { item: SavedReport }) {
  return (
    <section className={styles.invalid} aria-label="열 수 없는 저장한 리포트">
      <p role="alert">
        <strong>"{item.name}"</strong>은(는) 설정이 바뀌어 열 수 없습니다. 지금의 화면이 받지 않는 값이 들어 있습니다.
      </p>
      <pre className={styles.config}>{JSON.stringify(item.config, null, 2)}</pre>
      <DeleteSaved item={item} />
    </section>
  );
}
