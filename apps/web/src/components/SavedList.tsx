import { Link, useSearchParams } from "react-router";
import { KIND_LABELS, savedPath, useSavedReports } from "../api/saved";
import styles from "./Saved.module.css";

// 왼쪽의 저장한 리포트 목록(DESIGN 6.7). 세 화면 모두에서 연다. 지금의 스키마에 맞지 않는 것은 "열 수 없음"을 붙인다(열면 지우기만 된다).
export function SavedList() {
  const list = useSavedReports();
  const [params] = useSearchParams();
  const current = params.get("saved");
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
              <Link to={savedPath(item.kind, item.id)} aria-current={item.id === current ? "page" : undefined}>
                {item.name}{" "}
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
