import { Link, useLocation, useSearchParams } from "react-router";
import { KIND_LABELS, SAVED_PATHS, savedPath, useSavedReports } from "../api/saved";
import styles from "./Saved.module.css";

// 왼쪽의 저장한 리포트 목록(DESIGN 6.7). 세 화면 모두에서 연다. 지금의 스키마에 맞지 않는 것은 "열 수 없음"을 붙인다(열면 지우기만 된다).
export function SavedList() {
  const list = useSavedReports();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  // 지금 연 것: id가 같고 그 종류의 화면이어야 한다(다른 화면에 그 id를 붙인 주소는 열린 것이 아니다)
  const isCurrent = (id: string, kind: keyof typeof SAVED_PATHS) => id === params.get("saved") && pathname === SAVED_PATHS[kind];
  return (
    <nav aria-label="저장한 리포트" className={styles.list}>
      <h2>저장한 리포트</h2>
      {list.isPending ? (
        <p className={styles.hint}>읽는 중…</p>
      ) : list.isError ? (
        <p className={styles.hint}>
          목록을 읽지 못했습니다.{" "}
          <button type="button" onClick={() => void list.refetch()}>
            다시 하기
          </button>
        </p>
      ) : list.data.items.length === 0 ? (
        <p className={styles.hint}>아직 없습니다. 결과를 본 뒤 저장하세요.</p>
      ) : (
        <ul>
          {list.data.items.map((item) => (
            <li key={item.id}>
              <Link to={savedPath(item.kind, item.id)} aria-current={isCurrent(item.id, item.kind) ? "page" : undefined}>
                {item.name}
                <span className="visually-hidden">, </span>
                <span className={styles.kind}>
                  {KIND_LABELS[item.kind]}
                  {!item.valid && " · 열 수 없음"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
