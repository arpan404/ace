import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./test-support.ts";

test("an unset policy uses auto-review and a workspace or thread can select an explicit mode", async () => {
  const f = await fixture();
  try {
    expect((await f.service.get("permissions.defaultMode")).value).toBe("auto-review");
    await f.service.set("permissions.defaultMode", "ask", {
      kind: "workspace",
      workspace: f.workspace,
    });
    expect((await f.service.get("permissions.defaultMode", { workspace: f.workspace })).value).toBe(
      "ask",
    );
    await f.service.set("permissions.defaultMode", "full-access", {
      kind: "thread",
      thread: "thread",
    });
    expect(
      (await f.service.get("permissions.defaultMode", { workspace: f.workspace, thread: "thread" }))
        .value,
    ).toBe("full-access");
    expect((await f.service.get("permissions.defaultMode")).value).toBe("auto-review");
  } finally {
    await f.close();
  }
});

test.each([
  ["ask", "ask"],
  ["on-failure", "auto-review"],
  ["never", "full-access"],
] as const)("explicit legacy %s survives reopening as %s", async (old, expected) => {
  const f = await fixture();
  try {
    await f.write(f.globalPath, { "approvals.policy": old, "future.setting": "retained" });
    expect((await f.service.get("permissions.defaultMode")).value).toBe(expected);
    await f.service.set("logs.retention", "7d", { kind: "global" });
    expect(await readFile(f.globalPath, "utf8")).toContain('"future.setting"');
    expect((await f.service.get("permissions.defaultMode")).value).toBe(expected);
  } finally {
    await f.close();
  }
});

test("an old client changes the effective mode and a new key wins over a conflicting legacy document", async () => {
  const f = await fixture();
  try {
    await f.write(join(f.workspace, ".ace/settings.json"), {
      "approvals.policy": "never",
      "permissions.defaultMode": "read-only",
    });
    expect((await f.service.get("permissions.defaultMode", { workspace: f.workspace })).value).toBe(
      "read-only",
    );
    await f.service.set("approvals.policy", "ask", { kind: "workspace", workspace: f.workspace });
    expect((await f.service.get("permissions.defaultMode", { workspace: f.workspace })).value).toBe(
      "ask",
    );
  } finally {
    await f.close();
  }
});
