import type { Scenario } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const threadId = "thread-totals";

/** A thread in Auto-review whose agent is working, so it can ask to use an app. */
const working: Scenario = {
  thread: {
    id: threadId,
    workspaceId: "relay",
    title: "Reconcile totals",
    provider: "codex",
    permissionMode: "auto-review",
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

function askForApp(app: ReturnType<typeof harness>, bundleId: string) {
  app.daemon.screen.access.enabled = true;
  const asked = app.daemon.screen.requestApp(bundleId, "Compare the totals in the open sheet", {
    threadId,
    agentId: "root",
  });
  asked.catch(() => {});
  return asked;
}

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

// Answers are remembered on this device by interaction id; the test that answers in the
// thread runs last so the fake daemon's repeated ids don't read as answered earlier.
test("a sensitive app's request says it asks again every turn", async () => {
  const app = harness();
  app.play(working).runUntilBlocked();
  await app.open(`/t/${threadId}`);
  askForApp(app, "com.apple.keychainaccess");

  const card = await screen.findByRole("article", { name: "Let an agent use Keychain Access" });
  expect(within(card).getByText(/asks again every turn/)).toBeTruthy();
  expect(within(card).getByRole("button", { name: "Always allow" })).toBeTruthy();
});

test("Activity's card for an app request can't be approved by a reflex key, only denied", async () => {
  const app = harness();
  app.play(working).runUntilBlocked();
  await app.open("/activity");
  const asked = askForApp(app, "com.apple.calculator");

  const card = await screen.findByRole("article", { name: "Let an agent use Calculator" });
  await waitFor(() => expect(card.getAttribute("aria-current")).toBe("true"));
  await userEvent.keyboard("a");
  expect(app.daemon.screen.access.list(threadId)).toEqual([]);

  await userEvent.keyboard("d");

  await expect(asked).rejects.toMatchObject({ code: "denied" });
  expect(app.daemon.screen.access.list(threadId)).toEqual([]);
});

test("an agent asking for an app names the app, not its bundle id, answers in the shared verbs, and keeps the thread grant under Details", async () => {
  const app = harness();
  app.play(working).runUntilBlocked();
  await app.open(`/t/${threadId}`);
  const asked = askForApp(app, "com.apple.TextEdit");

  const card = await screen.findByRole("article", { name: "Let an agent use TextEdit" });
  expect(within(card).getByText("Compare the totals in the open sheet")).toBeTruthy();
  expect(within(card).queryByText("com.apple.TextEdit")).toBeNull();
  expect(
    within(card)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Allow once", "Always allow", "Deny", "Details"]);

  await userEvent.click(within(card).getByRole("button", { name: "Details" }));
  expect(within(card).getByText("com.apple.TextEdit")).toBeTruthy();
  await userEvent.click(within(card).getByRole("button", { name: "Allow for this thread" }));

  await asked;
  expect(app.daemon.screen.access.list(threadId).map((grant) => grant.scope)).toEqual(["thread"]);
});
