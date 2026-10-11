import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("a push click navigates and focuses an existing ace tab", async () => {
  const effects: string[] = [];
  let click:
    | ((event: {
        notification: { close(): void; data: unknown };
        waitUntil(promise: Promise<unknown>): void;
      }) => void)
    | undefined;
  vi.stubGlobal("self", {
    location: { origin: "https://ace.local" },
    addEventListener(type: string, listener: typeof click) {
      if (type === "notificationclick") click = listener;
    },
    clients: {
      async matchAll() {
        return [
          {
            url: "https://ace.local/settings",
            focused: false,
            async navigate(url: string) {
              effects.push(`navigate:${url}`);
            },
            async focus() {
              effects.push("focus");
            },
          },
        ];
      },
      async openWindow() {
        effects.push("new tab");
      },
    },
  });
  await import("./notification-worker.ts");
  let work: Promise<unknown> | undefined;
  click?.({
    notification: { close() {}, data: { path: "/t/thread-one" } },
    waitUntil(promise) {
      work = promise;
    },
  });
  await work;
  expect(effects).toEqual(["navigate:https://ace.local/t/thread-one", "focus"]);
});
