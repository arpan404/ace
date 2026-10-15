import { replayCursor } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 20000 });

const thread = "thread-replay-cursor";
const edit = (line: string) =>
  `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n Initial\n+${line}\n`;

test.each([
  ["a commit made in a terminal", { head: "b".repeat(40) }],
  ["a move to another checkout", { worktree: `/fake/worktrees/${thread}` }],
])(
  "the uncommitted diff reads git again after %s",
  async (_change, details) => {
    const app = harness();
    app.play(replayCursor()).runThrough("asked");
    app.daemon.workspace.setGitDiff(thread, edit("Before the change"));
    await app.open(`/t/${thread}`);
    await screen.findByRole("heading", { level: 1, name: "Replay cursor resets on every resume" });
    await screen.findByRole("button", { name: "Right panel" }, { timeout: 10000 });
    await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
    const panel = await screen.findByRole("region", { name: "Thread panel" });
    await userEvent.click(within(panel).getByRole("tab", { name: /Changes/ }));
    const diff = await within(panel).findByLabelText("Uncommitted diff");
    expect(diff.textContent).toContain("+Before the change");

    // Git now reports other changes; only the thread's checkout facts say so.
    app.daemon.workspace.setGitDiff(thread, edit("After the change"));
    app.daemon.workspace.setDetails(thread, details);
    await waitFor(() =>
      expect(within(panel).getByLabelText("Uncommitted diff").textContent).toContain(
        "+After the change",
      ),
    );
  },
  60_000,
);
