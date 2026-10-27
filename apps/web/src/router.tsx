import { createBrowserRouter, Navigate } from "react-router";
import { Layout } from "./components/Layout";
import { FunnelsPage, NotFoundPage, ReportsPage, RetentionPage } from "./pages/Placeholders";

// 경로(DESIGN 6.7). 첫 화면은 리포트다.
export const routes = [
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/reports" replace /> },
      { path: "reports", element: <ReportsPage /> },
      { path: "funnels", element: <FunnelsPage /> },
      { path: "retention", element: <RetentionPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
