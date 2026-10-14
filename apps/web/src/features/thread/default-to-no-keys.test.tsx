import type { Scenario } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { answerStore } from "@/features/thread/interactions/answers.ts";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
afterEach(() => answerStore.forgetAll());

/**
 * A provider approval, asking for an explicit yes or not. Each test asks its own question in
 * its own thread: this device remembers answers by interaction id, and the fake reuses ids.
 */
function asking(interaction: string, title: string, defaultToNo: boolean): Scenario {
  return {
    thread: {
      id: `thread-${interaction}`,
      workspaceId: "relay",
      title: "Migrate sessions",
      provider: "codex",
      access: "ask",
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
          {
            type: "interaction.opened",
            agent: "root",
            interaction,
            blocking: true,
            request: {
              kind: "approval",
              title,
              options: [
                { id: "allow", kind: "allow_once", label: "Allow once" },
                { id: "deny", kind: "deny", label: "Deny" },
              ],
              ...(defaultToNo ? { defaultToNo: true } : {}),
            },
          },
        ],
      },
      { kind: "await", interaction },
    ],
  };
}

/** Focus a card's button once the thread has settled, so the composer doesn't take focus back. */
async function focusIn(button: HTMLElement) {
  await screen.findByRole("combobox", { name: "Message" });
  await waitFor(() => {
    button.focus();
    expect(document.activeElement).toBe(button);
  });
}

test("in the thread, a number key can deny a request that defaults to no but never approve it", async () => {
  const app = harness();
  app.play(asking("truncate-logs", "Truncate the audit log?", true)).runUntilBlocked();
  await app.open("/t/thread-truncate-logs");
  const card = await screen.findByRole("article", { name: "Truncate the audit log?" });
  const allow = within(card).getByRole("button", { name: "Allow once" });
  const deny = within(card).getByRole("button", { name: "Deny" });
  expect(allow.getAttribute("aria-keyshortcuts")).toBeNull();
  expect(deny.getAttribute("aria-keyshortcuts")).toBe("2");

  await focusIn(deny);
  await userEvent.keyboard("1");
  expect(await within(card).findByText(/Read the request, then click Allow once/)).toBeTruthy();
  expect(app.daemon.isPending("thread-truncate-logs", "truncate-logs")).toBe(true);

  await userEvent.keyboard("2");
  await waitFor(
    () =>
      expect(app.daemon.resolution("thread-truncate-logs", "truncate-logs")).toEqual({
        kind: "approval",
        optionId: "deny",
      }),
    { timeout: 5000 },
  );
}, 15_000);

test("in the thread, a number key approves an ordinary request", async () => {
  const app = harness();
  app.play(asking("vacuum", "Vacuum the database?", false)).runUntilBlocked();
  await app.open("/t/thread-vacuum");
  const card = await screen.findByRole("article", { name: "Vacuum the database?" });
  await focusIn(within(card).getByRole("button", { name: "Deny" }));

  await userEvent.keyboard("1");
  await waitFor(
    () =>
      expect(app.daemon.resolution("thread-vacuum", "vacuum")).toEqual({
        kind: "approval",
        optionId: "allow",
      }),
    { timeout: 5000 },
  );
}, 15_000);

test("in the thread, Enter on a focused default-to-no Deny answers without granting the request", async () => {
  const app = harness();
  app.play(asking("deny-enter", "Remove the old audit data?", true)).runUntilBlocked();
  await app.open("/t/thread-deny-enter");
  const card = await screen.findByRole("article", { name: "Remove the old audit data?" });
  const deny = within(card).getByRole("button", { name: "Deny" });
  await focusIn(deny);
  expect(app.daemon.isPending("thread-deny-enter", "deny-enter")).toBe(true);
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(app.daemon.resolution("thread-deny-enter", "deny-enter")).toEqual({
      kind: "approval",
      optionId: "deny",
    }),
  );
});
