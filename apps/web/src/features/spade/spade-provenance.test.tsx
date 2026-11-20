import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { openProfile, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

test("a note says where it came from, and everything from that source can be forgotten", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) => {
    withEndpoint(api);
    api.addAgent({
      id: "main",
      kind: "main",
      name: "Spade",
      avatar: { kind: "spade" },
      model: "openrouter/anthropic/sonnet",
    });
    const travel = api.addAgent({
      id: "travel",
      name: "Travel",
      model: "openrouter/anthropic/sonnet",
    });
    const note = api.notes.add({ text: "Prefers aisle seats", agent: "travel", source: "bot" });
    const source = {
      key: `conversation:${travel.conversation}`,
      label: "Your conversation with Travel",
    };
    api.provenance.set(note.id, {
      text: note.text,
      sources: [source],
      conversation: { id: travel.conversation, agent: "travel", name: "Travel" },
      message: { seq: 1, at: Date.now(), text: "I like aisle seats" },
      call: "c1",
      source: "bot",
      at: Date.now(),
      trust: "kept",
    });
    api.learned.set("travel", [{ ...source, notes: 1, entries: 0 }]);
  });
  await screen.findByRole("feed", { name: "Conversation with Travel" });
  await openProfile("Travel");
  const profile = within(await screen.findByRole("region", { name: "Travel's profile" }));
  await userEvent.click(profile.getByRole("tab", { name: "Library" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Where it's from: Prefers aisle seats" }),
  );
  const why = within(await screen.findByRole("dialog", { name: "Where it's from" }));
  await why.findByText(/^Learned in your conversation with Travel/);
  expect(why.getByText("Answering your message “I like aisle seats”")).toBeTruthy();
  await userEvent.click(
    why.getByRole("button", { name: "Forget everything from Your conversation with Travel" }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Forget all of it" }));
  await waitFor(() =>
    expect(spade.forgotSources).toEqual([
      { agent: "travel", source: expect.stringMatching(/^conversation:/) },
    ]),
  );
});

test("a running Ollama is found and its models listed, and Use fills it in with no key", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
    withEndpoint(api);
    api.addAgent({
      id: "main",
      kind: "main",
      name: "Spade",
      avatar: { kind: "spade" },
      model: "openrouter/anthropic/sonnet",
    });
    api.localServers = [
      {
        id: "ollama",
        name: "Ollama",
        base_url: "http://127.0.0.1:11434/v1/",
        running: true,
        models: ["gemma3:4b", "qwen3:8b"],
        endpoint: null,
      },
      {
        id: "lmstudio",
        name: "LM Studio",
        base_url: "http://127.0.0.1:1234/v1/",
        running: false,
        models: [],
        endpoint: null,
      },
    ];
  });
  await userEvent.click(await screen.findByRole("button", { name: "Add an endpoint" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add endpoint" }));
  const here = within(await dialog.findByRole("region", { name: "On this computer" }));
  expect(here.getByText("Runs on this computer · 2 models")).toBeTruthy();
  expect(here.getByText("Not running on this computer")).toBeTruthy();
  await userEvent.click(here.getByRole("button", { name: "Use" }));
  await userEvent.click(dialog.getByRole("button", { name: "Add endpoint" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/endpoints")).toEqual([
      {
        name: "Ollama",
        format: "openai-chat",
        base_url: "http://127.0.0.1:11434/v1/",
        needs_key: false,
      },
    ]),
  );
});
