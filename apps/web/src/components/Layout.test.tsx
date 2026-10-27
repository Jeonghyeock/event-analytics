import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { routes } from "../router";

// 틀과 경로(DESIGN 6.7): 첫 화면은 리포트이고, 주 메뉴가 현재 화면을 표시한다.
describe("Layout", () => {
  it("첫 화면은 리포트이고 주 메뉴에 셋이 있다", async () => {
    render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/"] })} />);
    expect(await screen.findByRole("heading", { name: "리포트" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["리포트", "퍼널", "리텐션"]);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("리포트");
  });

  it("없는 경로는 없는 화면이다", async () => {
    render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/nope"] })} />);
    expect(await screen.findByRole("heading", { name: "없는 화면입니다" })).toBeTruthy();
  });
});
