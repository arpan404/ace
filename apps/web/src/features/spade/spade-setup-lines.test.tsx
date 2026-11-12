import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const garden = (api: FakeSpadeApi) => {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return api.addAgent({ id: "garden", name: "Garden" });
};

test("while Spade waits for the keychain, its panel says what to look for", async () => {
  await spadeApp("/spade", (api) => {
    garden(api);
    api.setStatus({
      state: "ready",
      version: "0.6.0",
      setup: { reason: "waiting for the keychain", platform: "darwin" },
    });
  });
  const line = await screen.findByText(
    "Spade is waiting for the keychain. Look for a macOS prompt and choose Always Allow.",
  );
  expect(line.closest("[role=status]")).not.toBeNull();
  // Spade still runs: its bots stay listed and nothing offers to turn it on.
  expect(await screen.findByRole("navigation", { name: "Bots" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
});

test("a running Spade with nothing to wait on shows no state line in its panel", async () => {
  await spadeApp("/spade", garden);
  await screen.findByRole("navigation", { name: "Bots" });
  expect(screen.queryByText(/waiting for the keychain/)).toBeNull();
});

test("a search with nothing set up ends the reply with a quiet line that opens the setting", async () => {
  await spadeApp("/spade/garden", (api) => {
    const c = garden(api).conversation;
    api.store(c, { type: "user_message", text: "When do I plant garlic?" });
    api.store(c, { type: "reply_started", reply: "r1" });
    for (const id of ["k1", "k2"]) {
      api.store(c, {
        type: "step_finished",
        reply: "r1",
        text: "",
        calls: [{ id, name: "web_search", arguments: { query: "garlic" } }],
      });
      api.store(c, {
        type: "tool_finished",
        reply: "r1",
        call_id: id,
        name: "web_search",
        is_error: true,
        content: "No web search is set up. Tell the person, in one short sentence, …",
      });
    }
    const said = "I can't search the web yet; add a search key in Settings.";
    api.store(c, { type: "step_finished", reply: "r1", text: said });
    api.store(c, { type: "reply_finished", reply: "r1", text: said });
  });
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Garden" }));
  await chat.findByText(/I can't search the web yet/);
  // Once, however often it searched, and nothing else of the tool.
  expect(chat.getAllByText("Web search isn't set up.")).toHaveLength(1);
  const open = chat.getByRole("link", { name: "Set up web search" });
  expect(open.getAttribute("href")).toBe("/settings/spade#web-search");
});

test("Settings › Spade › Web search keeps a Brave key in the keychain and a SearXNG address", async () => {
  const { spade } = await spadeApp("/settings/spade", garden);
  const section = within(await screen.findByRole("region", { name: "Web search" }));
  const key = section.getByLabelText<HTMLInputElement>("Brave Search key");
  // Typed into once Spade has said what is set up.
  await waitFor(() => expect(key.disabled).toBe(false));
  await userEvent.type(key, "BSA-123");
  await userEvent.click(section.getAllByRole("button", { name: "Save" })[0]!);
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/search/brave-key")).toEqual([{ key: "BSA-123" }]),
  );
  await section.findByText(/^Set\. Brave's search service/);
  expect(key.value).toBe("");

  const address = section.getByLabelText<HTMLInputElement>("SearXNG");
  await userEvent.type(address, "ftp://nope");
  await userEvent.click(section.getAllByRole("button", { name: "Save" })[1]!);
  expect((await section.findByRole("alert")).textContent).toContain("http:// or https://");
  await userEvent.clear(address);
  await userEvent.type(address, "http://localhost:8888");
  await userEvent.click(section.getAllByRole("button", { name: "Save" })[1]!);
  await waitFor(() => expect(address.value).toBe("http://localhost:8888/"));
  expect(spade.search.searxngUrl).toBe("http://localhost:8888/");

  await userEvent.click(section.getAllByRole("button", { name: "Remove" })[1]!);
  await waitFor(() => expect(spade.search.searxngUrl).toBeNull());
});
