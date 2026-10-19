import type { FakeDaemon } from "@ace/fake-daemon";

/*
 * The spike's projects and files for New thread, Add project and Files: folders on the host to
 * add, project `ace`'s own folder for New thread's Files, and in `ios-done`'s checkout a folder
 * with more files than the Files sheet lists and a log larger than its preview. No provider CLI
 * runs.
 */

const line = (index: number) =>
  `${new Date(1_790_000_000_000 + index * 1000).toISOString()} relay: ack seq=${index}`;

export function seedProjects(daemon: FakeDaemon): void {
  daemon.projects.seedFolders("/Users/arpan", [
    { path: "/Users/arpan/code/notes", git: true },
    { path: "/Users/arpan/code/dotfiles", git: true },
    { path: "/Users/arpan/code/scratch" },
  ]);
  for (let index = 0; index < 240; index++)
    daemon.checkouts.seed(
      "ios-done",
      `fixtures/snapshots/case-${String(index).padStart(3, "0")}.json`,
      `{"case":${index}}\n`,
    );
  daemon.checkouts.seed(
    "ios-done",
    "logs/relay.log",
    Array.from({ length: 6000 }, (_, index) => line(index)).join("\n"),
  );
  // New thread's Files browses project `ace`'s own folder before a thread is started.
  daemon.checkouts.seedProject(
    "ace",
    "docs/runbook.md",
    [
      "# Relay runbook",
      "",
      "1. Check the relay socket is up: `ace relay status`.",
      "2. A cold start replays from the last acknowledged sequence.",
      "3. The outbox keeps at most 500 messages while offline.",
      "",
    ].join("\n"),
  );
}
