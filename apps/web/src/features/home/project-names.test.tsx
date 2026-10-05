import { facts, type Scenario } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

// A real daemon names projects by an opaque id; people know them by name.
const billing = {
  id: "4b0c9e1a-77d2-4f1e-9a51-2f0d3c8e6b10",
  name: "billing",
  path: "/src/billing",
};

const thread: Scenario = {
  thread: {
    id: "thread-signing-keys",
    workspaceId: billing.id,
    title: "Rotate the signing keys",
    provider: "claude",
    details: { workspace: billing },
  },
  steps: [
    {
      kind: "facts",
      facts: [
        facts.rootAgent("claude"),
        facts.turn("root"),
        facts.message("root", "ask", "user", "Rotate the signing keys"),
        facts.endTurn("root", "completed"),
      ],
    },
  ],
};

function app() {
  const made = harness();
  made.play(thread).runUntilBlocked();
  return made;
}

test("Home's task rows and the thread header name the project, not its id", async () => {
  await app().open("/");
  const nav = await screen.findByRole("navigation", { name: "Threads" });
  const card = await within(nav).findByRole("link", {
    name: /^Rotate the signing keys\..*Project billing/,
  });
  // The row's badge and project line show the name, and its initials.
  expect(within(card).getByText("billing")).toBeTruthy();
  expect(within(card).getByText("BI")).toBeTruthy();
  expect(within(nav).queryByText(billing.id)).toBeNull();

  await userEvent.click(card);
  await screen.findByRole("heading", { level: 1, name: "Rotate the signing keys" });
  expect(screen.queryByText(billing.id)).toBeNull();
});

test("New thread offers the daemon's projects by name", async () => {
  await app().open("/new");
  expect(
    await screen.findByRole("heading", { name: "What should we work on in billing?" }),
  ).toBeTruthy();
  await userEvent.click(await screen.findByRole("button", { name: /^Project:/ }));
  expect(await screen.findByRole("menuitemradio", { name: "billing" })).toBeTruthy();
});
