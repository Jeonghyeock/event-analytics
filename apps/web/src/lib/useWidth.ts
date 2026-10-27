import { type RefObject, useLayoutEffect, useState } from "react";

// 요소의 실제 너비(px). 그래프는 이 너비를 viewBox로 써서 1:1로 그린다: 고정 viewBox를 늘려 그리면 넓은 화면에서는 글자가 커지고
// 폰에서는 읽을 수 없게 작아진다(스크린숏으로 확인). ResizeObserver가 없으면(jsdom) fallback이다.
export function useWidth(ref: RefObject<HTMLElement | null>, fallback = 800): number {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 첫 그리기 전에 한 번 재고(fallback으로 그렸다가 바뀌어 튀지 않게), 그 뒤로는 바뀔 때마다
    if (el.clientWidth > 0) setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry!.contentRect.width);
      if (w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
