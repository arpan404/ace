import { facts, type FakeDaemon } from "@ace/fake-daemon";

/*
 * The spike's `ios-files` thread for the Files screens: the relay checkout in a worktree with
 * uncommitted changes (one file modified, one added, one deleted) so the tree letters them and
 * the viewer marks changed lines, and an answer linking a checkout file at a line and a note
 * outside the checkout the host serves because the message links it. For saving and sending
 * files: nested folders (`docs/guides/setup/`), a folder whose archive is about 5 MB
 * (`assets/recordings/`, noise that doesn't compress), and `uploads/` with `notes.md` already
 * there so a picked `notes.md` asks to replace or keep both. Uploads land in the fake's memory
 * (16 MiB in all, with the seeded files). No provider CLI runs.
 */

const thread = "ios-files";
const root = "/tmp/ace-ios-spike/worktrees/ios-files";
const outbox = "apps/web/src/relay/outbox.ts";
const retry = "apps/web/src/relay/retry.ts";
const note = "/Users/arpan/Downloads/relay notes.txt";
const lines = (...text: string[]) => `${text.join("\n")}\n`;

const retrySource = lines(
  'import type { RelaySocket } from "./types.ts";',
  "",
  "/** Reconnect with backoff, from 500ms up to 10s, until the socket answers. */",
  "export async function reconnect(socket: RelaySocket, wait = 500): Promise<void> {",
  "  for (;;) {",
  "    if (await socket.open()) return;",
  "    await new Promise((resolve) => setTimeout(resolve, wait));",
  "    wait = Math.min(wait * 2, 10_000);",
  "  }",
  "}",
);
const patch = [
  `diff --git a/${outbox} b/${outbox}`,
  "index 41b2c3d..9f8e7a1 100644",
  `--- a/${outbox}`,
  `+++ b/${outbox}`,
  "@@ -3,4 +3,5 @@",
  " ",
  " /** Messages written while offline, sent in order once the relay socket is back. */",
  "-const MAX_BUFFERED = 200;",
  "+const MAX_BUFFERED = 500;",
  " ",
  "+export class Outbox {",
  `diff --git a/${retry} b/${retry}`,
  "new file mode 100644",
  "--- /dev/null",
  `+++ b/${retry}`,
  `@@ -0,0 +1,${retrySource.split("\n").length - 1} @@`,
  ...retrySource
    .split("\n")
    .slice(0, -1)
    .map((line) => `+${line}`),
  "diff --git a/apps/web/src/relay/legacy.ts b/apps/web/src/relay/legacy.ts",
  "deleted file mode 100644",
  "--- a/apps/web/src/relay/legacy.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const legacy = true;",
  "",
].join("\n");

/** Bytes that don't compress, the same every run. */
function noise(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed;
  for (let index = 0; index < size; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

/** Folders to browse, save and send files into. */
function seedTransfers(daemon: FakeDaemon): void {
  daemon.checkouts.seed(thread, "docs/guides/setup/install.md", lines("# Install", "", "bun i"));
  daemon.checkouts.seed(thread, "docs/guides/setup/phone.md", lines("# Pair a phone"));
  daemon.checkouts.seed(thread, "docs/guides/reference/wire.md", lines("# Wire format"));
  daemon.checkouts.seed(thread, "uploads/notes.md", lines("# Notes", "", "Kept on the host."));
  daemon.checkouts.seedBytes(thread, "assets/recordings/soak-1.bin", noise(3 * 1024 * 1024, 7));
  daemon.checkouts.seedBytes(thread, "assets/recordings/soak-2.bin", noise(2 * 1024 * 1024, 11));
  // About 3 MB of text: past the 2 MB a file shows whole, so the phone reads it in pages.
  const log = Array.from(
    { length: 48_000 },
    (_, index) =>
      `${String(index + 1).padStart(6, "0")} replay window=${index % 512} acked=${index * 3} dropped=0 ok`,
  ).join("\n");
  daemon.checkouts.seedBytes(thread, "logs/replay-soak.log", new TextEncoder().encode(`${log}\n`));
}

type Details = NonNullable<Parameters<FakeDaemon["createThread"]>[0]["details"]>;

export function seedFiles(daemon: FakeDaemon, details: (branch: string) => Details): void {
  daemon.createThread({
    hasSentMessage: true,
    id: thread,
    workspaceId: "ace",
    title: "Raise the relay outbox buffer",
    provider: "claude",
    details: details("fix/outbox-buffer"),
  });
  daemon.apply(thread, [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message(
      "root",
      "ask",
      "user",
      "The outbox drops messages after 200. Raise it and add a reconnect helper.",
    ),
    facts.message(
      "root",
      "answer",
      "assistant",
      `I raised the buffer in [outbox.ts](${root}/${outbox}:5) and added [retry.ts](${retry}). The numbers I measured are in [relay notes](<${note}>).`,
    ),
    facts.endTurn("root"),
  ]);
  daemon.workspace.setDetails(thread, {
    worktree: root,
    head: "4".repeat(40),
    ahead: 0,
    behind: 0,
    diff: { files: 3, additions: 12, deletions: 2 },
  });
  daemon.checkouts.seed(thread, retry, retrySource);
  seedTransfers(daemon);
  daemon.workspace.setGitStatus(thread, [
    { path: outbox, status: "modified", additions: 2, deletions: 1, binary: false },
    { path: retry, status: "added", additions: 10, deletions: 0, binary: false },
    {
      path: "apps/web/src/relay/legacy.ts",
      status: "deleted",
      additions: 0,
      deletions: 1,
      binary: false,
    },
  ]);
  daemon.workspace.setGitDiff(thread, patch);
  daemon.checkouts.seedLinked(
    thread,
    daemon.itemId(thread, "answer") ?? "",
    note,
    lines(
      "Relay soak, 20 Oct",
      "",
      "200 buffered: 3 drops in 10k sends",
      "500 buffered: 0 drops in 10k sends",
    ),
  );
}
