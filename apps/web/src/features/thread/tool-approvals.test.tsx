import type { Scenario } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { answerStore } from "./interactions/answers.ts";

beforeEach(() => localStorage.clear());
afterEach(() => answerStore.forgetAll());

const threadId = "thread-totals";

/** A thread in Auto-review whose agent is working, so it can ask for approval. */
const working: Scenario = {
  thread: {
    id: threadId,
    workspaceId: "relay",
    title: "Reconcile totals",
    provider: "codex",
    access: "auto-review",
  },
  steps: [
    {
      kind: "facts",
      facts: [
        {
          type: "agent.seen",
          agent: "root",
          origin: "root",
          fidelity: "full",
          native: { provider: "codex", nativeId: "root" },
          cwd: "/Users/dev/relay",
        },
        { type: "turn.started", agent: "root", nativeTurnId: "t1", trigger: "user" },
      ],
    },
  ],
};

test("an upload approval names every file it would send, the seventh included", async () => {
  const paths = Array.from(
    { length: 7 },
    (_, index) => `/Users/dev/Documents/report-${index + 1}.pdf`,
  );
  paths[6] = "/Users/dev/Documents/tax-return-2025.pdf";
  const app = harness();
  app
    .play({
      ...working,
      steps: [
        ...working.steps,
        {
          kind: "facts",
          facts: [
            {
              type: "interaction.opened",
              agent: "root",
              interaction: "upload",
              blocking: true,
              request: {
                kind: "approval",
                title: "Browser upload approval",
                target: {
                  tool: "browser.upload",
                  origin: "ace",
                  access: "execute",
                  input: { paths },
                },
                options: [
                  { id: "allow_once", kind: "allow_once", label: "Allow once" },
                  { id: "deny", kind: "deny", label: "Deny" },
                ],
                defaultToNo: true,
              },
            },
          ],
        },
        { kind: "await", interaction: "upload" },
      ],
    })
    .runUntilBlocked();
  await app.open(`/t/${threadId}`);

  const card = await screen.findByRole("article", {
    name: "Upload files from outside the project",
  });
  const files = within(card).getByRole("list", { name: "Files to upload" });
  expect(
    within(files)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(paths);
});
