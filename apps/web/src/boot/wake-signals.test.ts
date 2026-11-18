import { expect, test } from "vitest";
import { watchWakes } from "./wake-signals.ts";

/** A page's window and document, with the desktop bridge's resume cue when `desktop`. */
function page(desktop: boolean) {
  const scope = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const resumed = new Set<() => void>();
  Reflect.set(scope, "document", document);
  if (desktop)
    Reflect.set(scope, "ace", {
      onSystemResumed(listener: () => void) {
        resumed.add(listener);
        return () => resumed.delete(listener);
      },
    });
  let wakes = 0;
  const stop = watchWakes(() => wakes++, scope);
  return {
    wakes: () => wakes,
    stop,
    resume: () => resumed.forEach((listener) => listener()),
    online: () => scope.dispatchEvent(new Event("online")),
    restored: (persisted: boolean) =>
      scope.dispatchEvent(Object.assign(new Event("pageshow"), { persisted })),
    visibility(state: "visible" | "hidden") {
      document.visibilityState = state;
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

test("each way back to the daemon wakes the connection once", () => {
  const window = page(true);
  window.resume();
  window.online();
  window.visibility("visible");
  window.restored(true);
  expect(window.wakes()).toBe(4);
});

test("hiding the window or an ordinary first load is no wake", () => {
  const window = page(true);
  window.visibility("hidden");
  window.restored(false);
  expect(window.wakes()).toBe(0);
});

test("a browser without the desktop bridge still wakes on the page's own cues", () => {
  const window = page(false);
  window.online();
  window.visibility("visible");
  expect(window.wakes()).toBe(2);
});

test("after it stops, nothing wakes the connection", () => {
  const window = page(true);
  window.stop();
  window.resume();
  window.online();
  window.visibility("visible");
  expect(window.wakes()).toBe(0);
});
