import { expect, test } from "vitest";
import { remoteCliFixture } from "./cli-remote-test-support.ts";
import { invoke } from "./cli-test-support.ts";

test.each(["run", "chat"])(
  "remote %s refuses client-relative and host paths before registering or admitting work",
  { timeout: 30000 },
  async (verb) => {
    const f = await remoteCliFixture();
    try {
      const before = f.daemon.store.listThreads().map((thread) => thread.id);
      for (const project of ["./repo", f.h.home, "unregistered-workspace"]) {
        const args = [
          verb,
          ...(verb === "run" ? ["Do not admit this prompt"] : []),
          "--project",
          project,
          ...f.remoteArgs,
          "--json",
        ];
        const result = await invoke(
          f.home,
          args,
          verb === "chat" ? "Do not admit this prompt\n/quit\n" : "",
        );
        const records: unknown[] = result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(records).toContainEqual(expect.objectContaining({ status: "refused" }));
        expect(f.daemon.store.listThreads().map((thread) => thread.id)).toEqual(before);
        // The real wire boundary must receive neither workspace registration nor thread creation.
        expect(f.commands).toEqual([]);
      }
      const accepted = await invoke(f.home, [
        "run",
        "Use the registered remote project",
        "--project",
        f.workspace,
        ...f.remoteArgs,
        "--json",
      ]);
      expect(accepted.code, accepted.stderr).toBe(0);
      expect(f.daemon.store.listThreads()).toContainEqual(
        expect.objectContaining({
          id: JSON.parse(accepted.stdout).threadId,
          workspaceId: f.workspace,
        }),
      );
    } finally {
      await f.close();
    }
  },
);
