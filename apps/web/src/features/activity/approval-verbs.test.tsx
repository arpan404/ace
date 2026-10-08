import type { Scenario } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

const title = "Allow git push to main?";

/** A Full-access Codex thread whose agent asks to push, in Codex's own words for each option. */
const push: Scenario = {
  thread: {
    id: "thread-push",
    workspaceId: "relay",
    title: "Push",
    provider: "codex",
    permissionMode: "full-access",
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
          interaction: "approve-push",
          blocking: true,
          request: {
            kind: "approval",
            title,
            description: "Publishes the release branch.",
            options: [
              { id: "once", label: "Approve once", kind: "allow_once" },
              { id: "session", label: "Approve for this session", kind: "allow_session" },
              { id: "deny", label: "Decline", kind: "deny" },
              { id: "abort", label: "Abort the turn", kind: "cancel" },
            ],
          },
        },
      ],
    },
    { kind: "await", interaction: "approve-push" },
  ],
};

/** The decision buttons on a card, by their words: not its chrome, not Details. */
const verbs = (card: HTMLElement) =>
  within(card)
    .getAllByRole("button")
    .map((button) => button.textContent ?? "")
    .filter((label) => /^(Allow once|Always allow|Deny)/.test(label))
    .map((label) => label.replace(/[A-Z]$/, ""));

test("an approval answers in the same verbs in the thread and on Activity's card, reached from its list", async () => {
  const app = harness();
  app.play(push).runUntilBlocked();
  await app.open("/t/thread-push");
  const region = await screen.findByRole("region", { name: "Waiting for you" });
  const inThread = await within(region).findByRole("article", { name: title });
  expect(verbs(inThread)).toEqual(["Allow once", "Always allow", "Deny"]);
  // None of the provider's own labels reach the buttons.
  expect(within(inThread).queryByText(/Approve once|Decline/)).toBeNull();

  await userEvent.click(
    within(screen.getByRole("navigation", { name: "App" })).getByRole("link", {
      name: /^Activity/,
    }),
  );
  const inActivity = await within(screen.getByRole("main")).findByRole("article", {
    name: title,
  });
  await userEvent.click(
    within(inActivity).getByRole("button", { expanded: false, name: new RegExp(title) }),
  );
  expect(verbs(inActivity)).toEqual(["Allow once", "Always allow", "Deny"]);
  const list = await screen.findByRole("list", { name: "Activity" });
  const row = within(list).getByText(title).closest("li");
  if (!row) throw new Error("No row for the approval");
  expect(within(row).queryByRole("button", { name: "Allow once" })).toBeNull();
  expect(within(row).queryByRole("button", { name: "Deny" })).toBeNull();
  await userEvent.click(within(row).getByText(title));
  expect(
    verbs(await within(screen.getByRole("main")).findByRole("article", { name: title })),
  ).toEqual(["Allow once", "Always allow", "Deny"]);

  // The provider's other option keeps its words, behind Details.
  await userEvent.click(within(inActivity).getByRole("button", { name: "Details" }));
  await userEvent.click(within(inActivity).getByRole("button", { name: "Abort the turn" }));
  await waitFor(() =>
    expect(app.daemon.resolution("thread-push", "approve-push")).toEqual({
      kind: "approval",
      optionId: "abort",
    }),
  );
});
