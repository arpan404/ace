import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openNew, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const withSpade = (spade: FakeSpadeApi) => {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
};

async function choose(scope: ReturnType<typeof within>, select: string, option: string) {
  await userEvent.click(scope.getByRole("combobox", { name: select }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("the model picker lists what each endpoint serves with its facts, and takes a typed id", async () => {
  const { spade } = await spadeApp("/spade", withSpade);
  await openNew("New bot");
  // A new bot's model is at the top of its page, with how it runs.
  await userEvent.click(await screen.findByRole("button", { name: "Model" }));
  const models = within(await screen.findByRole("listbox", { name: "Models" }));
  await models.findByRole("option", { name: /^Sonnet/ });
  // With no model for new bots set, the first choice leaves it to Spade.
  const options = models.getAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual([
    "First usable modelSaved model",
    "Saved modelCtrl+1",
    "Llama128K contextCtrl+2",
    "Sonnet200K context·Ctrl+3",
  ]);
  const sonnet = options[3];
  if (!sonnet) throw new Error("Expected Sonnet option");
  expect(within(sonnet).getByRole("img", { name: "Images" })).toBeTruthy();
  expect(within(sonnet).getByRole("img", { name: "Tools" })).toBeTruthy();
  expect(
    within(screen.getByRole("group", { name: "OpenRouter" })).getAllByRole("option"),
  ).toHaveLength(3);
  await userEvent.type(screen.getByRole("combobox", { name: "Search models" }), "qwen/qwen3-coder");
  await userEvent.click(await screen.findByRole("option", { name: "Use “qwen/qwen3-coder”" }));
  // The typed id is chosen, shown in words as every model is.
  expect(screen.getByRole("button", { name: "Model" }).textContent).toBe(
    "Qwen3 coder · OpenRouter",
  );
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message New bot" }),
    "Review this project{Enter}",
  );
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents")).toEqual([
      expect.objectContaining({ model: "openrouter/qwen/qwen3-coder" }),
    ]),
  );
});

test("a bot on a machine that goes offline stays listed, as away", async () => {
  const { app } = await spadeApp("/spade", withSpade, {
    machines: [
      {
        hostId: "studio",
        name: "Studio Mac",
        seed: (spade) => void spade.addAgent({ id: "research", name: "Research" }),
      },
    ],
  });
  await botRow("Research");
  app.crashMachine("studio");
  await waitFor(async () =>
    expect((await botRow("Research")).textContent).toContain("Studio Mac is offline"),
  );
});

test("with no endpoint key, Spade's conversation asks for one and saves it to Spade", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    withEndpoint(api);
    const [endpoint] = api.endpoints;
    if (endpoint) endpoint.key_set = false;
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  });
  const setup = within(
    await screen.findByRole("region", { name: "Pick the model Spade answers with" }),
  );
  await userEvent.type(setup.getByLabelText("Key"), "sk-test");
  await userEvent.click(setup.getByRole("button", { name: "Save key" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/keys/openrouter")).toEqual([{ key: "sk-test" }]),
  );
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Pick the model Spade answers with" })).toBeNull(),
  );
});

test("an endpoint added from a preset reaches Spade, and one bots still use can't be removed", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
    withSpade(api);
    api.presets.push({
      id: "opencode-go",
      name: "OpenCode Go",
      format: "openai-chat",
      base_url: "https://opencode.ai/zen/go/v1/",
      key_env: "OPENCODE_API_KEY",
      session_header: "x-opencode-session",
    });
    api.addAgent({ id: "inbox", name: "Inbox", model: "openrouter/meta/llama" });
  });
  await userEvent.click(await screen.findByRole("button", { name: "Add a provider" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add a provider" }));
  await choose(dialog, "From", "OpenCode Go");
  await userEvent.click(dialog.getByRole("button", { name: "Add provider" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/endpoints")).toEqual([
      {
        name: "OpenCode Go",
        format: "openai-chat",
        base_url: "https://opencode.ai/zen/go/v1/",
        session_header: "x-opencode-session",
        preset: "opencode-go",
      },
    ]),
  );
  // An account is removed from its provider's page, from the account's menu.
  await userEvent.click(await screen.findByRole("link", { name: /^OpenRouter/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Manage OpenRouter" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove account…" }));
  // It asks once, saying the key goes too, then Spade's refusal shows where it was asked.
  const asked = within(
    await screen.findByRole("dialog", { name: "Remove OpenRouter from OpenRouter?" }),
  );
  expect(asked.getByText(/Its key leaves the keychain too\./)).toBeTruthy();
  await userEvent.click(asked.getByRole("button", { name: "Remove account" }));
  expect((await asked.findByRole("alert")).textContent).toBe("Spade, Inbox use this endpoint.");
  expect(spade.endpoints.map((endpoint) => endpoint.id)).toContain("openrouter");
});
