import { useEffect, useRef } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import styles from "./Layout.module.css";
import { SavedList } from "./SavedList";

// 화면 셋(리포트, 퍼널, 리텐션)의 틀(DESIGN 6.7). 저장한 리포트 목록은 왼쪽(좁은 화면에서는 위)에 있다.
export function Layout() {
  const main = useRef<HTMLElement>(null);
  const location = useLocation();

  // 화면이 바뀌면 새 화면의 제목(없으면 본문)으로 포커스를 옮긴다(화면 읽기 프로그램이 새 화면을 처음부터 읽게). 첫 화면은 그대로 둔다.
  // 보인 경로를 기억해 경로가 실제로 바뀔 때만 옮긴다(StrictMode가 effect를 두 번 돌려도 첫 화면에서 옮기지 않게, 코드 리뷰).
  const shownPath = useRef(location.pathname);
  useEffect(() => {
    if (shownPath.current === location.pathname) return;
    shownPath.current = location.pathname;
    const heading = main.current?.querySelector("h1");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus();
    } else {
      main.current?.focus();
    }
  }, [location.pathname]);

  return (
    <div className={styles.shell}>
      {/* 왼쪽 목록을 지나지 않고 본문으로(키보드). 주소에 #main을 붙이면 새 이동이 되어 연 화면이 새로 붙으므로 포커스만 옮긴다. */}
      <a
        href="#main"
        className={styles.skip}
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        본문으로 건너뛰기
      </a>
      <header className={styles.header}>
        <Link to="/reports" className={styles.brand}>
          이벤트 분석
        </Link>
        <nav aria-label="주 메뉴" className={styles.nav}>
          <NavLink to="/reports">리포트</NavLink>
          <NavLink to="/funnels">퍼널</NavLink>
          <NavLink to="/retention">리텐션</NavLink>
        </nav>
      </header>
      <div className={styles.columns}>
        <aside className={styles.aside}>
          <SavedList />
        </aside>
        <main ref={main} id="main" tabIndex={-1} className={styles.main}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
