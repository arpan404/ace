import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { VisibleImageUrl } from "./visible-image-url.tsx";

afterEach(() => vi.unstubAllGlobals());

test("an overflow thumbnail acquires its image only while it intersects the viewport", () => {
  const changes: ((visible: boolean) => void)[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      target: Element | undefined;
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        changes.push((visible) => {
          const target = this.target;
          if (!target) throw new Error("No observed image");
          const rect = target.getBoundingClientRect();
          callback([
            {
              target,
              isIntersecting: visible,
              intersectionRatio: visible ? 1 : 0,
              time: 0,
              rootBounds: null,
              boundingClientRect: rect,
              intersectionRect: rect,
            },
          ]);
        });
      }
      observe(target: Element) {
        this.target = target;
      }
      disconnect() {
        this.target = undefined;
      }
    },
  );
  render(
    <VisibleImageUrl source={{ kind: "url", url: "blob:preview" }} className="thumbnail">
      {(image) =>
        image.state === "ready" ? (
          <img src={image.url} alt="Overflow image" />
        ) : (
          <span>Waiting for visibility</span>
        )
      }
    </VisibleImageUrl>,
  );
  expect(screen.queryByRole("img", { name: "Overflow image" })).toBeNull();
  expect(screen.getByText("Waiting for visibility")).toBeTruthy();
  act(() => changes.forEach((change) => change(true)));
  expect(screen.getByRole("img", { name: "Overflow image" }).getAttribute("src")).toBe(
    "blob:preview",
  );
  act(() => changes.forEach((change) => change(false)));
  expect(screen.queryByRole("img", { name: "Overflow image" })).toBeNull();
});
