import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fixture } from "./test-support.ts";
test("new settings leave native defaults alone and provider overrides survive reopening", async () => {
  const f = await fixture();
  try {
    expect((await f.service.get("permissions.providerModes")).value).toEqual({});
    await f.service.set(
      "permissions.providerModes",
      { claude: "acceptEdits", opencode: "deny" },
      { kind: "global" },
    );
    expect((await f.service.get("permissions.providerModes")).value).toEqual({
      claude: "acceptEdits",
      opencode: "deny",
    });
    expect(
      JSON.parse(await readFile(f.globalPath, "utf8")).settings["permissions.providerModes"],
    ).toEqual({ claude: "acceptEdits", opencode: "deny" });
  } finally {
    await f.close();
  }
});
test.each([
  ["ask", "default", ":read-only"],
  ["auto-review", "auto", '{"permissions":":workspace","approvalsReviewer":"auto_review"}'],
  ["full-access", "bypassPermissions", ":danger-full-access"],
] as const)(
  "stored %s migrates once into separate native selections",
  async (old, claude, codex) => {
    const f = await fixture();
    try {
      await f.write(f.globalPath, { "permissions.defaultMode": old, "future.setting": "retained" });
      expect((await f.service.get("permissions.providerModes")).value).toMatchObject({
        claude,
        codex,
      });
      await f.service.set("threads.autoSettleAfter", "1w", { kind: "global" });
      const text = await readFile(f.globalPath, "utf8");
      expect(text).toContain('"future.setting"');
      expect(text).not.toContain(`"permissions.defaultMode": "${old}"`);
      expect((await f.service.get("permissions.providerModes")).value).toMatchObject({
        claude,
        codex,
      });
    } finally {
      await f.close();
    }
  },
);
test("a legacy client can replace a provider default without persisting the ace mode", async () => {
  const f = await fixture();
  try {
    await f.service.set("permissions.defaultMode", "ask", { kind: "global" });
    await f.service.set("approvals.policy", "never", { kind: "global" });
    expect((await f.service.get("permissions.providerModes")).value.claude).toBe(
      "bypassPermissions",
    );
    expect(
      JSON.parse(await readFile(f.globalPath, "utf8")).settings["approvals.policy"],
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("a project overrides one provider and keeps following other global defaults after restart", async () => {
  const f = await fixture();
  const scope = { workspace: f.workspace };
  try {
    await f.service.set(
      "permissions.providerModes",
      { claude: "default", opencode: "deny" },
      { kind: "global" },
    );
    await f.service.set(
      "permissions.providerModes",
      { claude: "acceptEdits" },
      { kind: "workspace", workspace: f.workspace },
    );
    expect((await f.service.get("permissions.providerModes", scope)).value).toEqual({
      claude: "acceptEdits",
      opencode: "deny",
    });
    await f.service.set(
      "permissions.providerModes",
      { claude: "auto", opencode: "ask" },
      { kind: "global" },
    );
    expect((await f.service.get("permissions.providerModes", scope)).value).toEqual({
      claude: "acceptEdits",
      opencode: "ask",
    });
    const { SettingsService } = await import("./index.ts");
    const restarted = new SettingsService({ dataDir: f.dataDir });
    try {
      expect((await restarted.get("permissions.providerModes", scope)).value).toEqual({
        claude: "acceptEdits",
        opencode: "ask",
      });
    } finally {
      await restarted.close();
    }
    await f.service.set(
      "permissions.providerModes",
      {},
      { kind: "workspace", workspace: f.workspace },
    );
    expect((await f.service.get("permissions.providerModes", scope)).value.claude).toBe("auto");
  } finally {
    await f.close();
  }
});

test("a legacy null permission default remains absence rather than a saved choice", async () => {
  const f = await fixture();
  try {
    await f.write(f.globalPath, { "permissions.defaultMode": null });
    expect((await f.service.get("permissions.providerModes")).value).toEqual({});
  } finally {
    await f.close();
  }
});
