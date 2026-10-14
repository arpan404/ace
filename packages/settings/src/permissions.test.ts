import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fixture } from "./test-support.ts";

test("a new daemon starts new threads in Auto review and remembers the person's choice", async () => {
  const f = await fixture();
  try {
    expect((await f.service.get("access.defaultMode")).value).toBe("auto-review");
    await f.service.set("access.defaultMode", "ask", { kind: "global" });
    expect((await f.service.get("access.defaultMode")).value).toBe("ask");
    expect(JSON.parse(await readFile(f.globalPath, "utf8")).settings["access.defaultMode"]).toBe(
      "ask",
    );
  } finally {
    await f.close();
  }
});

test.each([
  [{ claude: "default", codex: ":read-only", opencode: "plan" }, "read-only"],
  [{ claude: "acceptEdits", codex: ":workspace", cursor: "{}" }, "auto-review"],
  [{ claude: "bypassPermissions", codex: ":danger-full-access" }, "full-access"],
  // A tie goes to the stricter mode.
  [{ claude: "dontAsk", codex: ":danger-full-access" }, "ask"],
] as const)(
  "stored per-provider modes %j map once to the daemon default %s",
  async (providerModes, expected) => {
    const f = await fixture();
    try {
      await f.write(f.globalPath, {
        "permissions.providerModes": providerModes,
        "future.setting": "retained",
      });
      expect((await f.service.get("access.defaultMode")).value).toBe(expected);
      await f.service.set("threads.autoSettleAfter", "1w", { kind: "global" });
      const text = await readFile(f.globalPath, "utf8");
      expect(text).toContain('"future.setting"');
      expect(text).not.toContain("permissions.providerModes");
      expect((await f.service.get("access.defaultMode")).value).toBe(expected);
    } finally {
      await f.close();
    }
  },
);

test.each([
  [{ "permissions.defaultMode": "full-access" }, "full-access"],
  [{ "approvals.policy": "never" }, "full-access"],
  [{ "approvals.policy": "on-failure" }, "auto-review"],
] as const)("an older global mode %j maps once to %s", async (stored, expected) => {
  const f = await fixture();
  try {
    await f.write(f.globalPath, stored);
    expect((await f.service.get("access.defaultMode")).value).toBe(expected);
    const text = await readFile(f.globalPath, "utf8");
    expect(text).not.toContain("permissions.defaultMode");
    expect(text).not.toContain("approvals.policy");
  } finally {
    await f.close();
  }
});

test("an explicit daemon default wins over the mapping of older keys", async () => {
  const f = await fixture();
  try {
    await f.write(f.globalPath, {
      "access.defaultMode": "read-only",
      "permissions.providerModes": { claude: "bypassPermissions" },
    });
    expect((await f.service.get("access.defaultMode")).value).toBe("read-only");
  } finally {
    await f.close();
  }
});

test("an Advanced native mode is stored per provider", async () => {
  const f = await fixture();
  try {
    await f.service.set("access.nativeModes", { codex: "my-profile" }, { kind: "global" });
    expect((await f.service.get("access.nativeModes")).value).toEqual({ codex: "my-profile" });
  } finally {
    await f.close();
  }
});
