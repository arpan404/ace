import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const terms =
  "Using a ChatGPT sign-in outside OpenAI's own Codex apps may go against OpenAI's terms; you " +
  "sign in knowing that.";

const openaiPreset = {
  id: "openai",
  name: "OpenAI",
  format: "openai-responses",
  base_url: "https://api.openai.com/v1/",
  key_env: "OPENAI_API_KEY",
  session_header: null,
  models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
};

const account = (fields: Record<string, unknown>) => ({
  format: "openai-responses",
  base_url: "https://api.openai.com/v1/",
  header_names: [],
  session_header: null,
  needs_key: true,
  key_set: true,
  key_source: "keychain",
  provider: "openai",
  auth: "key",
  account: null,
  models: [{ id: "gpt-5.5", name: "GPT-5.5", source: "preset" }],
  ...fields,
});

const chatgpt = (signedIn: boolean) =>
  account({
    id: "chatgpt",
    name: "ChatGPT",
    auth: "chatgpt",
    needs_key: false,
    key_set: false,
    key_source: null,
    account: { email: "pat@example.com", plan: "pro", signed_in: signedIn },
  });

/** Spade, on the given model. */
const main = (spade: FakeSpadeApi, model: string) =>
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" }, model });

/** An account's row on its provider's page, by the account's name. */
async function accountRow(name: string) {
  const list = within(await screen.findByRole("list", { name: /accounts$/ }));
  await list.findByText(name);
  const row = list.getAllByRole("listitem").find((item) => within(item).queryByText(name));
  if (!row) throw new Error(`No account named ${name}`);
  return within(row);
}

/** Picks `item` from an account's ⋯ menu. */
async function fromMenu(name: string, item: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Manage ${name}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

test("the list gives each provider one row: its state, accounts and bots, and the fix it needs", async () => {
  await spadeApp("/settings/spade/models", (api) => {
    api.presets.push(openaiPreset);
    api.endpoints.push(
      account({ id: "openai", name: "Personal" }),
      account({
        id: "opencode-go",
        name: "OpenCode Go",
        provider: "opencode-go",
        key_set: false,
        key_source: null,
      }),
      chatgpt(true),
    );
    main(api, "chatgpt/gpt-5.5");
    api.addAgent({ id: "inbox", name: "Inbox", model: "chatgpt/gpt-5.5" });
  });
  const openai = within(await screen.findByRole("group", { name: "OpenAI" }));
  expect(openai.getByText("Ready")).toBeTruthy();
  expect(openai.getByText(/2 accounts · 2 bots/)).toBeTruthy();
  expect(openai.queryByRole("button")).toBeNull();
  const go = within(screen.getByRole("group", { name: "OpenCode Go" }));
  expect(go.getByText("Key missing")).toBeTruthy();
  expect(go.getByRole("button", { name: "Add a key to OpenCode Go" })).toBeTruthy();
});

test("a provider's page lists its accounts: who each is, how it signs in, and the bots on it", async () => {
  await spadeApp("/settings/spade/models/openai", (api) => {
    api.presets.push(openaiPreset);
    api.endpoints.push(account({ id: "openai", name: "Personal" }), chatgpt(true));
    main(api, "chatgpt/gpt-5.5");
    api.addAgent({ id: "inbox", name: "Inbox", model: "chatgpt/gpt-5.5" });
  });
  const personal = await accountRow("Personal");
  expect(personal.getByLabelText("Signed in with an API key")).toBeTruthy();
  const signedIn = await accountRow("ChatGPT");
  expect(signedIn.getByText("pat@example.com · Pro")).toBeTruthy();
  expect(signedIn.getByText("Used by Inbox and Spade")).toBeTruthy();
});

test("a missing key is fixed from the list: the key goes to Spade once and the provider is ready", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
    api.endpoints.push(
      account({
        id: "opencode-go",
        name: "OpenCode Go",
        provider: "opencode-go",
        key_set: false,
        key_source: null,
      }),
    );
    main(api, "opencode-go/gpt-5.5");
  });
  await userEvent.click(await screen.findByRole("button", { name: "Add a key to OpenCode Go" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add the key for OpenCode Go" }));
  await userEvent.type(dialog.getByLabelText("OpenCode Go key"), "sk-go-123");
  await userEvent.click(dialog.getByRole("button", { name: "Save key" }));
  const go = within(await screen.findByRole("group", { name: "OpenCode Go" }));
  expect(await go.findByText("Ready")).toBeTruthy();
  expect(spade.sent("PUT", "/v1/keys/opencode-go")).toEqual([{ key: "sk-go-123" }]);
});

test("signing in to ChatGPT with a code starts only after the terms sentence, then shows the account", async () => {
  const { spade } = await spadeApp("/settings/spade/models/openai", (api) => {
    api.presets.push(openaiPreset);
    api.endpoints.push(account({ id: "openai", name: "Personal" }));
    main(api, "openai/gpt-5.5");
  });
  await userEvent.click(await screen.findByRole("button", { name: "Add an OpenAI account" }));
  const choice = within(await screen.findByRole("dialog", { name: "Add an OpenAI account" }));
  await userEvent.click(choice.getByRole("radio", { name: /Sign in with ChatGPT/ }));
  await userEvent.click(choice.getByRole("button", { name: "Continue" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Sign in with ChatGPT" }));
  await userEvent.click(dialog.getByRole("radio", { name: /With a code/ }));
  expect(dialog.getByText(terms)).toBeTruthy();
  expect(spade.sent("POST", "/v1/accounts/chatgpt")).toEqual([]);
  await userEvent.click(dialog.getByRole("button", { name: "Continue" }));
  expect((await dialog.findByLabelText("Code")).textContent).toBe("WXYZ-2468");
  expect(dialog.getByRole("link").getAttribute("href")).toBe(
    "https://auth.openai.com/codex/device",
  );
  expect(spade.sent("POST", "/v1/accounts/chatgpt")).toEqual([
    { method: "device", terms_read: true },
  ]);
  expect(await dialog.findByText("Signed in as sam@example.com · Plus.")).toBeTruthy();
  await userEvent.click(dialog.getByRole("button", { name: "Done" }));
  const added = await accountRow("ChatGPT");
  expect(added.getByText("sam@example.com · Plus")).toBeTruthy();
});

test("a signed-out account leads its page, and a sign-in that fails says why and can be tried again", async () => {
  const { spade } = await spadeApp("/settings/spade/models/openai", (api) => {
    api.accounts.ending = "failed";
    api.endpoints.push(chatgpt(false));
    main(api, "chatgpt/gpt-5.5");
  });
  const problem = await screen.findByRole("status");
  expect(within(problem).getByText("ChatGPT is signed out, so Spade can't run.")).toBeTruthy();
  const signedOut = await accountRow("ChatGPT");
  await userEvent.click(signedOut.getByRole("button", { name: "Sign in" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Sign in with ChatGPT" }));
  await userEvent.click(dialog.getByRole("button", { name: "Continue" }));
  expect((await dialog.findByRole("alert")).textContent).toBe(
    "OpenAI didn't finish the sign-in. Try again.",
  );
  // A signed-out account is named, so the sign-in brings it back rather than adding one.
  expect(spade.sent("POST", "/v1/accounts/chatgpt")).toEqual([
    { method: "browser", terms_read: true, account: "chatgpt" },
  ]);
  await userEvent.click(dialog.getByRole("button", { name: "Try again" }));
  expect(dialog.getByText(terms)).toBeTruthy();
});

test("signing out keeps the account and its bots, and says it is signed out", async () => {
  const { spade } = await spadeApp("/settings/spade/models/openai", (api) => {
    api.endpoints.push(chatgpt(true));
    main(api, "chatgpt/gpt-5.5");
  });
  await fromMenu("ChatGPT", "Sign out");
  const row = await accountRow("ChatGPT");
  expect(await row.findByText("Signed out")).toBeTruthy();
  expect(row.getByText("Used by Spade")).toBeTruthy();
  expect(spade.sent("POST", "/v1/endpoints/chatgpt/sign-out")).toHaveLength(1);
  await userEvent.click(row.getByRole("button", { name: "Manage ChatGPT" }));
  expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull();
});

test("renaming an account changes its name only: the bots' model references stay", async () => {
  const { spade } = await spadeApp("/settings/spade/models/openai", (api) => {
    api.presets.push(openaiPreset);
    api.endpoints.push(account({ id: "openai", name: "Personal" }));
    main(api, "openai/gpt-5.5");
  });
  await fromMenu("Personal", "Rename");
  const name = await screen.findByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Work{Enter}");
  const work = await accountRow("Work");
  expect(work.getByText("Used by Spade")).toBeTruthy();
  expect(spade.sent("PATCH", "/v1/endpoints/openai")).toEqual([{ name: "Work" }]);
  expect(spade.sent("PATCH", "/v1/agents/main")).toEqual([]);
  expect(spade.agents.find((agent) => agent.id === "main")?.model).toBe("openai/gpt-5.5");
});

test("another account of a preset is added by its name, and the preset fills in the rest", async () => {
  const { spade } = await spadeApp("/settings/spade/models/openai", (api) => {
    api.presets.push(openaiPreset);
    api.accounts.signIn = [];
    api.endpoints.push(account({ id: "openai", name: "Personal" }));
    main(api, "openai/gpt-5.5");
  });
  await userEvent.click(await screen.findByRole("button", { name: "Add an OpenAI account" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add an OpenAI account" }));
  // Without ChatGPT sign-in on this Spade, a key is the only way.
  expect(dialog.queryByRole("radio")).toBeNull();
  await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "Work");
  await userEvent.click(dialog.getByRole("button", { name: "Add account" }));
  const work = await accountRow("Work");
  expect(work.getByText("Key missing")).toBeTruthy();
  expect(work.getByRole("button", { name: "Add key" })).toBeTruthy();
  expect(spade.sent("POST", "/v1/endpoints")).toEqual([{ preset: "openai", name: "Work" }]);
});
