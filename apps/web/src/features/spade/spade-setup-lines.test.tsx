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
  expect(open.getAttribute("href")).toBe("/settings/spade/search");
});

// Saving changes what Spade searches with, which draws the choice again: found each time.
const choose = async (engine: string) =>
  userEvent.click(
    within(await screen.findByRole("group", { name: "Search with" })).getByRole("button", {
      name: engine,
    }),
  );

test("Web search takes one choice and only the field it needs: Brave's key, SearXNG's address, or off", async () => {
  const { spade } = await spadeApp("/settings/spade/search", garden);
  expect(await screen.findByText(/^Bots can't search the web\./)).toBeTruthy();

  await choose("Brave");
  const key = screen.getByLabelText<HTMLInputElement>("Key");
  await userEvent.type(key, "BSA-123");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/search/brave-key")).toEqual([{ key: "BSA-123" }]),
  );
  expect(await screen.findByText("Saved in the keychain")).toBeTruthy();

  await choose("SearXNG");
  const address = screen.getByLabelText<HTMLInputElement>("Address");
  await userEvent.type(address, "ftp://nope{Enter}");
  // The refusal says the fix under the field; nothing else explains it before.
  expect((await screen.findByRole("alert")).textContent).toContain("http:// or https://");
  await userEvent.clear(address);
  await userEvent.type(address, "http://localhost:8888{Enter}");
  await waitFor(() => expect(spade.search.searxngUrl).toBe("http://localhost:8888/"));

  await choose("Off");
  await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
  await waitFor(() => expect(spade.search.searxngUrl).toBeNull());
  await waitFor(() => expect(spade.sent("DELETE", "/v1/search/brave-key")).toHaveLength(1));
  expect(await screen.findByText(/^Bots can't search the web\./)).toBeTruthy();
});

test("while the setting loads, Run Spade shows neither on nor off, and spending holds its place", async () => {
  await spadeApp("/settings/spade", garden, {
    daemon: (daemon) => daemon.holdRequests("settings.subscribe"),
  });
  const row = (await screen.findByText("Run Spade on this machine")).closest("[data-setting-slot]");
  if (!(row instanceof HTMLElement)) throw new Error("no Run Spade row");
  // Its place is held by a placeholder, never an off switch that may be on.
  expect(within(row).queryByRole("switch")).toBeNull();
  expect(screen.getByRole("region", { name: "Spending, every bot together" })).toBeTruthy();
});
