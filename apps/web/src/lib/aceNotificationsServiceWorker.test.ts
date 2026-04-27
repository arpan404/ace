import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

function loadServiceWorkerHarness(input?: {
  matchAll?: () => Promise<unknown[]>;
  openWindow?: (url: string) => Promise<unknown>;
}) {
  const addEventListener = vi.fn();
  const matchAll = vi.fn(input?.matchAll ?? (async () => []));
  const openWindow = vi.fn(input?.openWindow ?? (async () => undefined));
  const context = {
    URL,
    self: {
      addEventListener,
      clients: {
        matchAll,
        openWindow,
      },
      location: {
        origin: "https://ace.test",
      },
    },
  };
  const filePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../public/ace-notifications-sw.js",
  );
  vm.runInNewContext(readFileSync(filePath, "utf8"), context);
  const [, handler] = addEventListener.mock.calls[0] as [
    string,
    (event: {
      notification: { close: () => void; data?: Record<string, unknown> | null };
      waitUntil: (promise: Promise<unknown>) => void;
    }) => void,
  ];
  return {
    handler,
    matchAll,
    openWindow,
  };
}

describe("ace notification service worker", () => {
  it("navigates an existing client window to the full target url when provided", async () => {
    const focus = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => undefined);
    const { handler, matchAll, openWindow } = loadServiceWorkerHarness({
      matchAll: async () => [{ focus, navigate }],
    });
    const close = vi.fn();
    const waitUntil = vi.fn();

    handler({
      notification: {
        close,
        data: {
          deepLink: "/thread-1",
          targetUrl: "/thread-1?connection=ws%3A%2F%2Fremote.example",
        },
      },
      waitUntil,
    });

    const waitedPromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await waitedPromise;

    expect(close).toHaveBeenCalledOnce();
    expect(matchAll).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(
      "https://ace.test/thread-1?connection=ws%3A%2F%2Fremote.example",
    );
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("falls back to the deep link when a full target url is absent", async () => {
    const focus = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => undefined);
    const { handler } = loadServiceWorkerHarness({
      matchAll: async () => [{ focus, navigate }],
    });
    const waitUntil = vi.fn();

    handler({
      notification: {
        close: vi.fn(),
        data: {
          deepLink: "/thread-2",
        },
      },
      waitUntil,
    });

    const waitedPromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await waitedPromise;

    expect(focus).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("https://ace.test/thread-2");
  });

  it("opens a new window when no existing client is available", async () => {
    const { handler, openWindow } = loadServiceWorkerHarness();
    const waitUntil = vi.fn();

    handler({
      notification: {
        close: vi.fn(),
        data: {
          targetUrl: "/thread-3?connection=ws%3A%2F%2Fremote.example",
        },
      },
      waitUntil,
    });

    const waitedPromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await waitedPromise;

    expect(openWindow).toHaveBeenCalledWith(
      "https://ace.test/thread-3?connection=ws%3A%2F%2Fremote.example",
    );
  });
});
