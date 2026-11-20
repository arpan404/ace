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

test("a Spade alert pushed to a browser opens its bot's conversation at the request", async () => {
  const shown: { title: string; options: NotificationOptions }[] = [];
  const effects: string[] = [];
  const listeners: Record<string, (event: never) => void> = {};
  vi.stubGlobal("self", {
    location: { origin: "https://ace.local" },
    addEventListener(type: string, listener: (event: never) => void) {
      listeners[type] = listener;
    },
    registration: {
      async showNotification(title: string, options: NotificationOptions) {
        shown.push({ title, options });
      },
    },
    clients: {
      async matchAll() {
        return [];
      },
      async openWindow(url: string) {
        effects.push(`open:${url}`);
      },
    },
  });
  await import("./notification-worker.ts");
  let work: Promise<unknown> | undefined;
  const waitUntil = (promise: Promise<unknown>) => {
    work = promise;
  };
  const alert = {
    id: "spade:event:c1:7",
    threadId: "spade-host",
    title: "Booker",
    status: "spade",
    message: "Asks: Window or aisle?",
    backgroundCount: 0,
    actions: [],
    spade: { agent: "a1", conversation: "c1", request: "q2", category: "needs_you" },
  };
  listeners.push?.({ data: { json: () => alert }, waitUntil } as never);
  await work;
  expect(shown).toEqual([
    {
      title: "Booker",
      options: {
        body: "Asks: Window or aisle?",
        tag: "spade:a1",
        data: { path: "/spade/a1?request=q2" },
      },
    },
  ]);
  listeners.notificationclick?.({
    notification: { close() {}, data: shown[0]?.options.data },
    waitUntil,
  } as never);
  await work;
  expect(effects).toEqual(["open:https://ace.local/spade/a1?request=q2"]);
});
