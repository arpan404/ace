import { expect, test } from "vitest";
import { accountSessionsInMemory } from "./window-session.ts";

function backing() {
  const values = new Map<string, string>();
  const raw = {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  } as Storage;
  // `Object.keys` on a real Storage lists its keys; this stand-in lists them the same way.
  return {
    values,
    raw: new Proxy(raw, {
      ownKeys: () => [...values.keys()],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    }),
  };
}

test("a window's ace session never reaches session storage, and an older build's copy there is removed", () => {
  const { values, raw } = backing();
  values.set("ace.account.session:https://cloud.acehq.dev", '{"token":"old-plaintext"}');
  values.set("ace.machine.outbox", "kept");
  const storage = accountSessionsInMemory(
    { getItem: raw.getItem, setItem: raw.setItem, removeItem: raw.removeItem },
    raw,
  );
  expect(values.has("ace.account.session:https://cloud.acehq.dev")).toBe(false);
  storage.setItem("ace.account.session:https://cloud.acehq.dev", '{"token":"new"}');
  expect(storage.getItem("ace.account.session:https://cloud.acehq.dev")).toBe('{"token":"new"}');
  expect([...values.values()].join()).not.toContain("new");
  // Everything else is kept where it was.
  storage.setItem("ace.other", "on-disk");
  expect(values.get("ace.other")).toBe("on-disk");
  expect(storage.getItem("ace.machine.outbox")).toBe("kept");
});
