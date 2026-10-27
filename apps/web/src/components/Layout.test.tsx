import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { routes } from "../router";

// 틀과 경로(DESIGN 6.7): 첫 화면은 리포트이고, 주 메뉴가 현재 화면을 표시한다.
const renderAt = (path: string) =>
  render(
    <StrictMode>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </StrictMode>,
  );

describe("Layout", () => {
  it("첫 화면은 리포트이고 주 메뉴에 셋이 있다", async () => {
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "리포트" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["리포트", "퍼널", "리텐션"]);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("리포트");
  });

  it("첫 화면에서는 포커스를 옮기지 않고(\"/\"에서 넘겨 와도, StrictMode여도), 화면을 바꾸면 새 제목으로 옮긴다", async () => {
    renderAt("/");
    await screen.findByRole("heading", { name: "리포트" });
    expect(document.activeElement).toBe(document.body);
    await userEvent.click(screen.getByRole("link", { name: "퍼널" }));
    expect(document.activeElement).toBe(await screen.findByRole("heading", { name: "퍼널" }));
  });

  it("없는 경로는 없는 화면이다", async () => {
    renderAt("/nope");
    expect(await screen.findByRole("heading", { name: "없는 화면입니다" })).toBeTruthy();
  });
});
