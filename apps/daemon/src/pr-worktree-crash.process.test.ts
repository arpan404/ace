import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { expect, test } from "vitest";
import { Command, DeviceId } from "@ace/protocol";
import { prDaemon, run } from "./pr-worktree-test-support.ts";
import { maliciousPr } from "./pr-worktree-execution-test-support.ts";

for (const dirty of [false, true]) {
  test(`fresh PR intent after SIGKILL ${dirty ? "preserves an edited orphan and requires cleanup" : "cleans the orphan and reclaims interrupted draft capacity without replaying old commands"}`, async () => {
    const security = maliciousPr("all");
    const d = await prDaemon(security.options);
    let child: ReturnType<typeof spawn> | undefined;
    let exited: Promise<unknown> | undefined;
    try {
      const targets = [];
      for (let index = 0; index < 16; index++) targets.push(await d.h.create());
      const commands = targets.slice(0, 16).map((threadId, index) =>
        Command.parse({
          id: `interrupted-${index}`,
          deviceId: "device",
          payload: { type: "forge.pr.worktree", threadId, pullRequest: d.selection },
        }),
      );
      await d.pauseForCrash();
      child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./testing/pr-creation-crash-worker.ts", import.meta.url)),
          JSON.stringify({
            home: d.h.home,
            directory: d.directory,
            ghDirectory: d.gh.dir,
            executable: d.gh.executable,
            commands,
          }),
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      exited = once(child, "exit");
      const checkout = Promise.withResolvers<string>();
      let errors = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      child.on("message", (value: unknown) => {
        checkout.resolve(
          z.object({ type: z.literal("checkout"), path: z.string() }).parse(value).path,
        );
      });
      const orphan = await Promise.race([
        checkout.promise,
        exited.then(() => {
          throw new Error(`Crash fixture exited: ${errors}`);
        }),
      ]);
      expect(await run(orphan, "rev-parse", "HEAD")).toBe(d.head);
      if (dirty) await writeFile(join(orphan, "personal-edit.txt"), "Keep this edit\n");
      child.kill("SIGKILL");
      await exited;
      await d.resumeAfterCrash();
      await security.expectNoExecution();
      const freshTarget = targets[0];
      if (!freshTarget) throw new Error("Missing fresh target");
      if (dirty) {
        expect(await d.work(freshTarget, "fresh-after-crash")).toMatchObject({
          ok: false,
          error: "workspace_cleanup_required",
        });
        expect(
          d.runtime.creationDrafts.get("interrupted-0", DeviceId.parse("device"))?.progress,
        ).toMatchObject({ state: "failed", cleanupComplete: false, actions: [] });
        await expect(access(join(orphan, "personal-edit.txt"))).resolves.toBeUndefined();
        await rm(join(orphan, "personal-edit.txt"));
        return;
      }
      expect(await d.work(freshTarget, "fresh-after-crash")).toMatchObject({ ok: true });
      await expect(access(orphan)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await run(d.h.store.getThread(freshTarget)?.details?.worktree ?? "", "rev-parse", "HEAD"),
      ).toBe(d.head);
      expect(await d.runtime.git.listWorktrees(d.h.home)).toHaveLength(2);
      await d.reopen();
      for (const target of targets.slice(1, 16))
        expect(d.h.store.getThread(target)?.details?.worktreeCreation).toMatchObject({
          state: "failed",
          cleanupComplete: true,
        });
      expect(await d.work(targets.at(-1) ?? freshTarget, "another-fresh-intent")).toMatchObject({
        ok: true,
      });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await d.close();
      await security.expectNoExecution();
    }
  });
}
