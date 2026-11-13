import { render } from "@testing-library/react";
import { botFaceDefaults } from "@ace/ui-core/bot-face";
import { afterEach, expect, test, vi } from "vitest";
import { BotFace } from "./bot-face.tsx";

afterEach(() => vi.unstubAllGlobals());

test("faces share one observer and pause outside the viewport, resuming on return", () => {
  let notify: IntersectionObserverCallback | undefined;
  let observers = 0;
  const targets = new Set<Element>();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        observers++;
        notify = callback;
      }
      observe(target: Element) {
        targets.add(target);
      }
      unobserve(target: Element) {
        targets.delete(target);
      }
      disconnect() {
        targets.clear();
      }
    },
  );
  const view = render(
    <>
      <BotFace face={botFaceDefaults} size={32} state="working" />
      <BotFace face={botFaceDefaults} size={32} state="thinking" />
    </>,
  );
  const faces = Array.from(view.container.querySelectorAll("svg"));
  expect(observers).toBe(1);
  expect(targets.size).toBe(2);
  for (const face of faces) expect(face.style.getPropertyValue("--bf-play-state")).toBe("paused");
  const change = (target: SVGSVGElement, visible: boolean) => {
    const rect = target.getBoundingClientRect();
    notify?.(
      [
        {
          target,
          isIntersecting: visible,
          intersectionRatio: visible ? 1 : 0,
          time: 0,
          rootBounds: null,
          boundingClientRect: rect,
          intersectionRect: rect,
        },
      ],
      {} as IntersectionObserver,
    );
  };
  const [first, second] = faces;
  if (!first || !second) throw new Error("missing faces");
  change(first, true);
  expect(first.style.getPropertyValue("--bf-play-state")).toBe("running");
  expect(second.style.getPropertyValue("--bf-play-state")).toBe("paused");
  change(first, false);
  expect(first.getAttribute("data-visible")).toBe("false");
  expect(first.style.getPropertyValue("--bf-play-state")).toBe("paused");
  change(first, true);
  expect(first.style.getPropertyValue("--bf-play-state")).toBe("running");
  view.unmount();
  expect(targets.size).toBe(0);
});
