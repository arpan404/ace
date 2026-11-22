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

test("each provider lists its accounts, with how each signs in and the bots on it", async () => {
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
  const openai = within(await screen.findByRole("region", { name: "OpenAI" }));
  const personal = within(openai.getByRole("group", { name: "Personal" }));
  expect(personal.getByText("Saved in the keychain")).toBeTruthy();
  expect(personal.getByText("No bot uses it")).toBeTruthy();
  const signedIn = within(openai.getByRole("group", { name: "ChatGPT" }));
  expect(signedIn.getByText("Signed in as pat@example.com · Pro")).toBeTruthy();
  expect(signedIn.getByText("Used by Inbox and Spade")).toBeTruthy();
  const go = within(screen.getByRole("region", { name: "OpenCode Go" }));
  expect(go.getByText("Not saved")).toBeTruthy();
});

test("signing in to ChatGPT with a code starts only after the terms sentence, then shows the account", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
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
  const openai = within(await screen.findByRole("region", { name: "OpenAI" }));
  const added = within(await openai.findByRole("group", { name: "ChatGPT" }));
  expect(added.getByText("Signed in as sam@example.com · Plus")).toBeTruthy();
});

test("a sign-in that fails says why and can be tried again", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
    api.accounts.ending = "failed";
    api.endpoints.push(chatgpt(false));
    main(api, "chatgpt/gpt-5.5");
  });
  const signedOut = within(await screen.findByRole("group", { name: "ChatGPT" }));
  await userEvent.click(signedOut.getByRole("button", { name: "Sign in again" }));
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
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
    api.endpoints.push(chatgpt(true));
    main(api, "chatgpt/gpt-5.5");
  });
  const card = within(await screen.findByRole("group", { name: "ChatGPT" }));
  await userEvent.click(card.getByRole("button", { name: "Sign out" }));
  expect(await card.findByText("Signed out")).toBeTruthy();
  expect(card.getByText("Used by Spade")).toBeTruthy();
  expect(card.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(spade.sent("POST", "/v1/endpoints/chatgpt/sign-out")).toHaveLength(1);
});

test("renaming an account changes its name only: the bots' model references stay", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
    api.presets.push(openaiPreset);
    api.endpoints.push(account({ id: "openai", name: "Personal" }));
    main(api, "openai/gpt-5.5");
  });
  await userEvent.click(await screen.findByRole("button", { name: "Rename Personal" }));
  const name = screen.getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Work{Enter}");
  const work = within(await screen.findByRole("group", { name: "Work" }));
  expect(work.getByText("Used by Spade")).toBeTruthy();
  expect(spade.sent("PATCH", "/v1/endpoints/openai")).toEqual([{ name: "Work" }]);
  expect(spade.sent("PATCH", "/v1/agents/main")).toEqual([]);
  expect(spade.agents.find((agent) => agent.id === "main")?.model).toBe("openai/gpt-5.5");
});

test("another account of a preset is added by its name, and the preset fills in the rest", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
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
  const openai = within(await screen.findByRole("region", { name: "OpenAI" }));
  const work = within(await openai.findByRole("group", { name: "Work" }));
  expect(work.getByText("Not saved")).toBeTruthy();
  expect(spade.sent("POST", "/v1/endpoints")).toEqual([{ preset: "openai", name: "Work" }]);
});
