import { expect, test } from "vitest";
import { DaemonUrl, loadTarget } from "./connection-settings.ts";

function store(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const token = "a".repeat(64);

test("a fresh desktop window, with no address stored, loads no target instead of throwing", () => {
  // The desktop window asks for its remembered address with an empty fallback (#2250).
  const loaded = loadTarget({ local: store(), session: store() }, "");
  expect(loaded).toEqual({ url: "", target: undefined, remembered: false });
});

test("a malformed stored address falls back to the default instead of throwing", () => {
  const stores = {
    local: store({ "ace.daemon.url": "not a url", "ace.daemon.token": token }),
    session: store(),
  };
  const loaded = loadTarget(stores);
  expect(loaded.url).toBe("ws://127.0.0.1:4242/");
  expect(loaded.target).toBeUndefined();
});

test("an address that won't parse is refused with a message, like one on the wrong scheme", () => {
  for (const input of ["", "nope", "https://example.com/"]) {
    const parsed = DaemonUrl.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.at(-1)?.message).toBe("Use a ws:// or wss:// address");
  }
  expect(DaemonUrl.safeParse("ws://127.0.0.1:4242/").success).toBe(true);
});
