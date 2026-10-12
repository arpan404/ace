import { watch } from "node:fs";
import { ServerMessage } from "@ace/protocol";
import type { RawData } from "ws";
import type { Client } from "./socket-test-support.ts";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { prDaemon, run } from "./pr-worktree-test-support.ts";

export const lfsPointer =
  "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 42\n";

/** The fork supplies executable files; the person's Git configuration names those drivers. */
export function maliciousPr(
  attack: "smudge" | "lfs" | "fsmonitor" | "hook" | "all",
  outcome: "accepted" | "moved" | "waiting" = "accepted",
) {
  const markers: string[] = [];
  let verificationMarker = "";
  const options: Parameters<typeof prDaemon>[0] = {
    fork: true,
    async content(root, scratch) {
      verificationMarker = join(scratch, "verification-waiting");
      const script = (kind: string, tail: string) => {
        const marker = join(scratch, `${kind}-executed`);
        markers.push(marker);
        return `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n${tail}\n`;
      };
      await writeFile(
        join(root, "a-filter.cjs"),
        script("filter", "process.stdin.pipe(process.stdout)"),
      );
      await writeFile(join(root, "a-lfs.cjs"), script("lfs", "process.exit(1)"));
      await writeFile(
        join(root, "a-fsmonitor.cjs"),
        script("fsmonitor", "process.stdout.write('token\\0')"),
      );
      await writeFile(join(root, "a-hook.cjs"), script("hook", ""));
      await writeFile(join(root, ".gitattributes"), "pr.txt filter=review\nz-lfs.txt filter=lfs\n");
      await writeFile(join(root, "z-lfs.txt"), lfsPointer);
      await mkdir(join(root, ".githooks"));
      await writeFile(
        join(root, ".githooks", "post-index-change"),
        "#!/bin/sh\nnode a-hook.cjs\n",
        { mode: 0o755 },
      );
    },
    async configureGit(root) {
      if (attack === "smudge" || attack === "all") {
        await run(root, "config", "filter.review.smudge", "node a-filter.cjs");
        await run(root, "config", "filter.review.clean", "node a-filter.cjs");
        await run(root, "config", "filter.review.required", "true");
      }
      if (attack === "lfs" || attack === "all") {
        await run(root, "config", "filter.lfs.process", "node a-lfs.cjs");
        await run(root, "config", "filter.lfs.required", "true");
      }
      if (attack === "fsmonitor" || attack === "all") {
        await run(root, "config", "core.fsmonitor", "node a-fsmonitor.cjs");
        await run(root, "config", "core.untrackedCache", "true");
      }
      if (attack === "hook" || attack === "all")
        await run(root, "config", "core.hooksPath", ".githooks");
    },
    configure(fixtures) {
      if (outcome === "accepted") return;
      const entry = fixtures["repos/octo/ace/pulls/7"]?.[0];
      fixtures["repos/octo/ace/pulls/7"] = [
        entry ?? {},
        entry ?? {},
        outcome === "waiting"
          ? { wait: true, waitMarker: verificationMarker }
          : {
              body: {
                ...(typeof entry?.body === "object" ? entry.body : {}),
                head: {
                  sha: "c".repeat(40),
                  ref: "feat/fix",
                  repo: { owner: { login: "contributor" }, name: "ace" },
                },
              },
            },
      ];
    },
  };
  return {
    options,
    async waitForVerification(client: Client, commandId: string): Promise<void> {
      if (!verificationMarker) throw new Error("Missing verification barrier");
      return new Promise((resolve, reject) => {
        const finish = (error?: unknown) => {
          watcher.close();
          client.socket.off("message", response);
          client.socket.off("close", closed);
          if (error) reject(error);
          else resolve();
        };
        const check = () => {
          void access(verificationMarker).then(
            () => finish(),
            (error: unknown) => {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                finish(error);
            },
          );
        };
        const response = (data: RawData) => {
          const message = ServerMessage.parse(JSON.parse(data.toString()));
          if (message.type === "commandResult" && message.commandId === commandId)
            finish(
              new Error(
                `Preparation settled before final verification: ${message.error ?? "success"}`,
              ),
            );
        };
        const closed = () => finish(new Error("Socket closed before verification"));
        const watcher = watch(dirname(verificationMarker), { persistent: false }, check);
        watcher.on("error", finish);
        client.socket.on("message", response);
        client.socket.on("close", closed);
        check();
      });
    },
    async expectNoExecution() {
      for (const marker of markers)
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  };
}
