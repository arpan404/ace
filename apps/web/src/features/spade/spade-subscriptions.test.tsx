import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openNew, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const withSubscriptions = (spade: FakeSpadeApi) => {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  // What ace lists: only providers it has installed and signed in.
  spade.subscriptions = [
    {
      provider: "codex",
      name: "Codex",
      accounts: [
        { id: "work", label: "Work" },
        { id: "home", label: null },
      ],
      models: [
        { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
        { id: "gpt-6.1-luna", name: "GPT-6.1 Luna" },
      ],
    },
  ];
};

test("the model picker offers your subscriptions beside endpoints, per account, and a bot is made on one", async () => {
  const { spade } = await spadeApp("/spade", withSubscriptions);
  await openNew("New bot");
  const name = await screen.findByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Notes");
  await userEvent.click(screen.getByRole("button", { name: "Model" }));
  const work = await screen.findByRole("group", { name: "Codex · Work" });
  expect(screen.getByRole("group", { name: "Codex · home" })).toBeTruthy();
  await userEvent.click(within(work).getByRole("option", { name: "GPT-6.1 Luna" }));
  await userEvent.type(screen.getByRole("combobox", { name: "Message Notes" }), "Hi{Enter}");
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents")).toEqual([
      expect.objectContaining({ name: "Notes", model: "cli:codex@work/gpt-6.1-luna" }),
    ]),
  );
});

test("a bot whose subscription can't run says the next step in its row", async () => {
  await spadeApp("/spade", (spade) => {
    withSubscriptions(spade);
    spade.addAgent({
      name: "Notes",
      model: "cli:codex@work/gpt-6.1-sol",
      problem: "Codex is signed out. Sign in to it in ace, then send again.",
      last_message: { from: "person", text: "Hi", at: 1, from_agent: null },
    });
  });
  const row = await botRow("Notes");
  expect(row.textContent).toContain("Sign in to Codex to go on");
  expect(row.textContent).not.toContain("You: Hi");
});
