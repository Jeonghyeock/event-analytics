import { createBrowserRouter, redirect } from "react-router";
import { Layout } from "./components/Layout";
import { FunnelsPage } from "./pages/FunnelsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ReportsPage } from "./pages/ReportsPage";
import { RetentionPage } from "./pages/RetentionPage";

// 경로(DESIGN 6.7). 첫 화면은 리포트다. "/"는 그리기 전에(loader) 넘긴다: 그린 뒤 <Navigate>로 넘기면 경로가 한 번 더 바뀌어
// 틀이 첫 화면에서도 제목으로 포커스를 옮긴다(코드 리뷰). loader가 있으면 첫 그리기 전 자리(HydrateFallback)가 필요하다.
export const routes = [
  {
    path: "/",
    element: <Layout />,
    HydrateFallback: () => null,
    children: [
      { index: true, loader: () => redirect("/reports"), Component: () => null },
      { path: "reports", element: <ReportsPage /> },
      { path: "funnels", element: <FunnelsPage /> },
      { path: "retention", element: <RetentionPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
