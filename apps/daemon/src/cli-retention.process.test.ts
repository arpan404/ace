import { mkdir, writeFile, readFile, utimes, access } from "node:fs/promises";
import { join } from "node:path";
import { StoragePlan, StorageUsage } from "@ace/protocol";
import { expect, test } from "vitest";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";

test("clean previews daemon retention and applies the reviewed batch durably without removing the current log", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  try {
    await mkdir(join(home, "logs"), { recursive: true });
    const old = join(home, "logs/ace.1.jsonl"),
      current = join(home, "logs/ace.jsonl");
    await writeFile(old, "rotated");
    await utimes(old, 0, 0);
    await writeFile(current, "current");
    f.h.clock.advance(30 * 86400000);
    const usage = await invoke(home, ["storage", "--json"]);
    expect(usage.code, usage.stderr).toBe(0);
    expect(StorageUsage.parse(JSON.parse(usage.stdout)).categories).toContainEqual(
      expect.objectContaining({ kind: "logs", items: expect.any(Number) }),
    );
    const preview = await invoke(home, ["clean", "--dry-run", "--kinds", "logs", "--json"]);
    expect(preview.code, preview.stderr).toBe(0);
    const plan = StoragePlan.parse(JSON.parse(preview.stdout));
    expect(plan.items).toContainEqual(
      expect.objectContaining({ label: "logs/ace.1.jsonl", disposition: "remove" }),
    );
    expect(plan.items).toContainEqual(
      expect.objectContaining({ label: "logs/ace.jsonl", disposition: "protect" }),
    );
    expect(await readFile(old, "utf8")).toBe("rotated");
    const args = ["clean", "apply", plan.id, "--revision", plan.revision, "--json"];
    const applied = await invoke(home, args);
    expect(applied.code, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      planId: plan.id,
      state: "complete",
    });
    await expect(access(old)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(current, "utf8")).toBe("current");
    const retry = await invoke(home, args);
    expect(JSON.parse(retry.stdout)).toEqual(JSON.parse(applied.stdout));
    const status = await invoke(home, ["clean", "status", plan.id, "--json"]);
    expect(JSON.parse(status.stdout)).toMatchObject({ planId: plan.id, state: "complete" });
  } finally {
    await f.daemon.close();
  }
});

test("clean refuses a changed reviewed file and requires a new preview", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  try {
    await mkdir(join(home, "logs"), { recursive: true });
    const path = join(home, "logs/ace.2.jsonl");
    await writeFile(path, "old");
    await utimes(path, 0, 0);
    f.h.clock.advance(30 * 86400000);
    const preview = await invoke(home, ["clean", "--dry-run", "--kinds", "logs", "--json"]);
    const plan = StoragePlan.parse(JSON.parse(preview.stdout));
    await writeFile(path, "replacement");
    const output = await invoke(home, [
      "clean",
      "apply",
      plan.id,
      "--revision",
      plan.revision,
      "--json",
    ]);
    expect(output.code, output.stderr).toBe(4);
    expect(JSON.parse(output.stdout)).toMatchObject({ planId: plan.id, state: "stale" });
    expect(await readFile(path, "utf8")).toBe("replacement");
  } finally {
    await f.daemon.close();
  }
});
