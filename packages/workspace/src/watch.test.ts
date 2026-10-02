import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { batches, exec, fixture } from "./test-support.ts";

describe("workspace watching", () => {
  it("batches native create, change and delete notifications while hiding ignored and git paths", async () => {
    const { service, root, file } = await fixture({}, true);
    await file(".gitignore", "*.log\nignored/\n");
    const events = batches();
    const watcher = await service.watch({ onChange: events.onChange });
    try {
      expect(watcher.mode).toBe("native");
      const created = events.next("a.ts", "created");
      await file("secret.log", "ignore");
      await file("ignored/a.ts", "ignore");
      await file(".git/ace-test", "ignore");
      await Promise.all([file("a.ts", "a"), file("b.ts", "b")]);
      const batch = await created;
      await watcher.flush();
      expect(events.history.flat()).toContainEqual({ path: "b.ts", kind: "created" });
      expect(batch.filter((change) => change.path === "a.ts")).toHaveLength(1);
      const changed = events.next("a.ts", "changed");
      await file("a.ts", "edited content");
      expect(await changed).toContainEqual({ path: "a.ts", kind: "changed" });
      const deleted = events.next("a.ts", "deleted");
      await rm(join(root, "a.ts"));
      expect(await deleted).toContainEqual({ path: "a.ts", kind: "deleted" });
      await watcher.flush();
      expect(
        events.history
          .flat()
          .some(
            (change) =>
              change.path.includes(".git/") ||
              change.path.endsWith(".log") ||
              change.path.startsWith("ignored/"),
          ),
      ).toBe(false);
    } finally {
      await watcher.dispose();
    }
    const count = events.history.length;
    await file("after-dispose.ts", "no callback");
    await watcher.flush();
    await watcher.dispose();
    expect(events.history).toHaveLength(count);
  });
  it("omits unsupported discovered filenames without corrupting listing or watch paths", async () => {
    const { service, file } = await fixture();
    await file("existing\\name", "unsupported");
    await file("new/name", "stable");
    await file("valid.ts", "before");
    expect((await service.list({ dir: "", depth: 2 })).entries.map((entry) => entry.path)).toEqual([
      "new",
      "new/name",
      "valid.ts",
    ]);
    const events = batches();
    const watcher = await service.watch({ onChange: events.onChange });
    try {
      expect(watcher.mode).toBe("native");
      const changed = events.next("valid.ts", "changed");
      await file("new\\name", "unsupported");
      await file("valid.ts", "after");
      await changed;
      await watcher.flush();
      expect(events.history.flat().every((change) => change.path === "valid.ts")).toBe(true);
    } finally {
      await watcher.dispose();
    }
  });
  it("reports new directory contents and every removed descendant through native batches", async () => {
    const { service, root, file } = await fixture();
    await file("old/deep/a.ts", "a");
    await file("old/b.ts", "b");
    const events = batches();
    const watcher = await service.watch({ onChange: events.onChange });
    try {
      expect(watcher.mode).toBe("native");
      const created = events.next("new/deep/c.ts", "created");
      await file("new/deep/c.ts", "c");
      expect(await created).toContainEqual({ path: "new/deep/c.ts", kind: "created" });
      const removed = events.next("old/deep/a.ts", "deleted");
      await rm(join(root, "old"), { recursive: true });
      await removed;
      await watcher.flush();
      expect(events.history.flat()).toEqual(
        expect.arrayContaining([
          { path: "old", kind: "deleted" },
          { path: "old/deep", kind: "deleted" },
          { path: "old/deep/a.ts", kind: "deleted" },
          { path: "old/b.ts", kind: "deleted" },
        ]),
      );
    } finally {
      await watcher.dispose();
    }
  });
  it("polls with a clear warning and detects changes without native notifications", async () => {
    const { service, root, file } = await fixture({ watchMode: "polling" });
    await file("original", "before");
    const events = batches();
    const warnings: string[] = [];
    const watcher = await service.watch({
      onChange: events.onChange,
      onWarning: (message) => warnings.push(message),
    });
    try {
      expect(watcher.mode).toBe("polling");
      expect(warnings.join(" ")).toContain("falling back to polling");
      const observed = events.next("new/deep", "created");
      await file("new/deep", "created");
      await file("original", "changed content");
      await observed;
      await watcher.flush();
      expect(events.history.flat()).toEqual(
        expect.arrayContaining([
          { path: "new/deep", kind: "created" },
          { path: "original", kind: "changed" },
        ]),
      );
      await rm(join(root, "new"), { recursive: true });
      await watcher.flush();
      expect(events.history.flat()).toContainEqual({ path: "new/deep", kind: "deleted" });
    } finally {
      await watcher.dispose();
    }
  });
  it("keeps a standalone polling subscription alive until it delivers and is disposed", async () => {
    const { root } = await fixture();
    const module = new URL("./index.ts", import.meta.url).href;
    const { stdout } = await exec(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import { createWorkspace } from ${JSON.stringify(module)};
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      const root = process.argv[1];
      const service = await createWorkspace(root, { watchMode: 'polling' });
      let acknowledge;
      const delivered = new Promise(resolve => { acknowledge = resolve; });
      const subscription = await service.watch({ onWarning() {}, onChange(batch) {
        if (batch.some(change => change.path === 'new' && change.kind === 'created')) acknowledge(batch);
      } });
      await writeFile(join(root, 'new'), 'created');
      console.log(JSON.stringify(await delivered));
      await subscription.dispose();
    `,
      root,
    ]);
    expect(JSON.parse(stdout)).toContainEqual({ path: "new", kind: "created" });
  });
  it("coalesces multiple writes and reconciles ignore-rule changes", async () => {
    const { service, file } = await fixture({ watchMode: "polling" }, true);
    await file("a.txt", "initial");
    const events = batches();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const watcher = await service.watch({ onChange: events.onChange, onWarning() {} });
      try {
        await file("a.txt", "first");
        await file("a.txt", "second");
        await watcher.flush();
        expect(events.history.flat().filter((change) => change.path === "a.txt")).toEqual([
          { path: "a.txt", kind: "changed" },
        ]);
        await file(".gitignore", "a.txt\n");
        await watcher.flush();
        expect(events.history.flat()).toContainEqual({ path: "a.txt", kind: "deleted" });
        await file(".gitignore", "");
        await watcher.flush();
        expect(events.history.flat()).toContainEqual({ path: "a.txt", kind: "created" });
      } finally {
        await watcher.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
