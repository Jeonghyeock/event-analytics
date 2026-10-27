import { useEffect, useRef } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import styles from "./Layout.module.css";

// 화면 셋(리포트, 퍼널, 리텐션)의 틀(DESIGN 6.7). 저장한 리포트 목록은 저장한 리포트 PR에서 왼쪽에 더한다.
export function Layout() {
  const main = useRef<HTMLElement>(null);
  const location = useLocation();

  // 화면이 바뀌면 새 화면의 제목(없으면 본문)으로 포커스를 옮긴다(화면 읽기 프로그램이 새 화면을 처음부터 읽게). 첫 화면은 그대로 둔다.
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
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
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          이벤트 분석
        </Link>
        <nav aria-label="주 메뉴" className={styles.nav}>
          <NavLink to="/reports">리포트</NavLink>
          <NavLink to="/funnels">퍼널</NavLink>
          <NavLink to="/retention">리텐션</NavLink>
        </nav>
      </header>
      <main ref={main} tabIndex={-1} className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
