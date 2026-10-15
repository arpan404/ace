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
  [{ "permissions.providerModes": { claude: "bypassPermissions" } }],
  [{ "permissions.defaultMode": "full-access" }],
  [{ "approvals.policy": "never" }],
  [{ "access.defaultMode": "read-only", "approvals.policy": "never" }],
] as const)(
  "settings with the retired access key %j are refused, not reinterpreted",
  async (stored) => {
    const f = await fixture();
    try {
      await f.write(f.globalPath, stored);
      await expect(
        f.service.set("threads.autoSettleAfter", "1w", { kind: "global" }),
      ).rejects.toThrow(/no longer reads.*access\.defaultMode/);
      // The person's file is left as written, for them to fix.
      expect(JSON.parse(await readFile(f.globalPath, "utf8")).settings).toEqual(stored);
    } finally {
      await f.close();
    }
  },
);

test("an Advanced native mode is stored per provider", async () => {
  const f = await fixture();
  try {
    await f.service.set("access.nativeModes", { codex: "my-profile" }, { kind: "global" });
    expect((await f.service.get("access.nativeModes")).value).toEqual({ codex: "my-profile" });
  } finally {
    await f.close();
  }
});
