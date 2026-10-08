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
      permissionMode: "ask",
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

test("in Activity, A doesn't approve a request that defaults to no; a click does", async () => {
  const app = harness();
  app.play(asking("drop-table", "Drop the legacy sessions table?", true)).runUntilBlocked();
  await app.open("/activity");
  const card = await screen.findByRole("article", { name: "Drop the legacy sessions table?" });
  await waitFor(() => expect(card.getAttribute("aria-current")).toBe("true"));
  // Allow once carries no A key to press.
  expect(within(card).getByRole("button", { name: "Allow once" }).textContent).toBe("Allow once");

  await userEvent.keyboard("a");
  expect(await within(card).findByText(/Read the request, then click Allow once/)).toBeTruthy();
  expect(app.daemon.isPending("thread-drop-table", "drop-table")).toBe(true);

  await userEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(app.daemon.resolution("thread-drop-table", "drop-table")).toEqual({
      kind: "approval",
      optionId: "allow",
    }),
  );
});

test("in Activity, A still approves an ordinary request", async () => {
  const app = harness();
  app.play(asking("add-index", "Add an index on sessions.user_id?", false)).runUntilBlocked();
  await app.open("/activity");
  const card = await screen.findByRole("article", { name: "Add an index on sessions.user_id?" });
  await waitFor(() => expect(card.getAttribute("aria-current")).toBe("true"));

  await userEvent.keyboard("a");
  await waitFor(() =>
    expect(app.daemon.resolution("thread-add-index", "add-index")).toEqual({
      kind: "approval",
      optionId: "allow",
    }),
  );
});

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
