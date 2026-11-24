import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** First-run setup in Spade's conversation, named by its heading. */
const setupName = "Pick the model Spade answers with";

/** Spade as it starts with no key anywhere: on the presets' main model. */
const main = (spade: FakeSpadeApi, model = "opencode-go/kimi-k2") =>
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" }, model });
const opencode = {
  id: "opencode-go",
  name: "OpenCode Go",
  format: "openai-chat",
  base_url: "https://opencode.ai/zen/go/v1/",
  key_env: "OPENCODE_API_KEY",
  session_header: "x-opencode-session",
  models: [{ id: "kimi-k2", name: "Kimi K2" }],
};
const anthropic = {
  id: "anthropic",
  name: "Anthropic",
  format: "anthropic",
  base_url: "https://api.anthropic.com/v1/",
  key_env: "ANTHROPIC_API_KEY",
  session_header: null,
  models: [{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }],
};

test("a local endpoint can be added without a key", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
    withEndpoint(api);
    main(api);
  });
  await userEvent.click(await screen.findByRole("button", { name: "Add a provider" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add a provider" }));
  await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "Ollama");
  await userEvent.type(
    dialog.getByRole("textbox", { name: "Base URL" }),
    "http://localhost:11434/v1/",
  );
  await userEvent.click(dialog.getByRole("switch", { name: "Needs a key" }));
  await userEvent.click(dialog.getByRole("button", { name: "Add provider" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/endpoints")).toEqual([
      {
        name: "Ollama",
        format: "openai-chat",
        base_url: "http://localhost:11434/v1/",
        needs_key: false,
      },
    ]),
  );
});

test("Azure's template waits for a real resource name before it can be added", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
    withEndpoint(api);
    main(api, "openrouter/saved/model");
  });
  await userEvent.click(await screen.findByRole("button", { name: "Add a provider" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add a provider" }));
  await userEvent.click(dialog.getByRole("combobox", { name: "From" }));
  await userEvent.click(await screen.findByRole("option", { name: "Azure OpenAI" }));
  // The generated URL still holds RESOURCE_NAME, so Add provider stays off and says why.
  const add = dialog.getByRole("button", { name: "Add provider" });
  expect((add as HTMLButtonElement).disabled).toBe(true);
  expect(dialog.getByText("Enter your Azure resource name.")).toBeTruthy();
  await userEvent.type(
    dialog.getByRole("textbox", { name: "Azure resource name" }),
    "contoso-ai",
  );
  expect((add as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(add);
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/endpoints")).toEqual([
      {
        name: "Azure OpenAI",
        format: "openai-responses",
        base_url: "https://contoso-ai.openai.azure.com/openai/v1/",
      },
    ]),
  );
});

test("on a machine without a keychain, Spade's conversation says which variable to set", async () => {
  await spadeApp("/spade", (api) => {
    api.keychain = false;
    api.presets.push(opencode);
    main(api);
  });
  const setup = within(await screen.findByRole("region", { name: setupName }));
  expect(setup.getByText(/^This machine has no keychain\. Set OPENCODE_API_KEY/)).toBeTruthy();
  expect(setup.queryByRole("button", { name: "Save key" })).toBeNull();
});

test("an endpoint made while saving its key stays made: trying again sets its key, never adds another", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    api.presets.push(opencode);
    api.keyFailure = 500;
    main(api);
  });
  const setup = within(await screen.findByRole("region", { name: setupName }));
  await userEvent.type(setup.getByLabelText("Key"), "sk-1");
  await userEvent.click(setup.getByRole("button", { name: "Save key" }));
  expect((await setup.findByRole("alert")).textContent).toBe("The keychain refused the key.");
  spade.keyFailure = undefined;
  await userEvent.type(setup.getByLabelText("Key"), "sk-2");
  await userEvent.click(setup.getByRole("button", { name: "Save key" }));
  await waitFor(() => expect(spade.sent("PUT", "/v1/keys/opencode-go")).toHaveLength(2));
  expect(spade.sent("POST", "/v1/endpoints")).toHaveLength(1);
  await waitFor(() => expect(screen.queryByRole("region", { name: setupName })).toBeNull());
});

/** Opens the OpenRouter account's Manage models from its provider page. */
async function manageOpenRouter() {
  await userEvent.click(await screen.findByRole("link", { name: "OpenRouter" }));
  await userEvent.click(await screen.findByRole("button", { name: "Manage" }));
  return within(await screen.findByRole("dialog", { name: "Models on OpenRouter" }));
}

test("a saved model turned off leaves the account; the preset's own stay on", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
    withEndpoint(api);
    const [endpoint] = api.endpoints;
    if (endpoint)
      endpoint.models = [
        { id: "saved/model", name: "Saved model", source: "typed" },
        { id: "preset/model", name: "Preset model", source: "preset" },
      ];
    main(api);
  });
  const models = await manageOpenRouter();
  const preset = await models.findByRole("switch", { name: "Preset model on OpenRouter" });
  expect(preset.getAttribute("aria-checked")).toBe("true");
  expect(preset.hasAttribute("data-disabled")).toBe(true);
  const saved = models.getByRole("switch", { name: "Saved model on OpenRouter" });
  expect(saved.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(saved);
  await waitFor(() =>
    expect(
      ((spade.endpoints[0]?.models ?? []) as { id: string }[]).map((model) => model.id),
    ).toEqual(["preset/model"]),
  );
  // The provider doesn't list it, so once off it is gone from the account and the list.
  await waitFor(() =>
    expect(models.queryByRole("switch", { name: "Saved model on OpenRouter" })).toBeNull(),
  );
});

test("first run on another endpoint's key moves Spade onto that endpoint's model", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    api.presets.push(opencode, anthropic);
    main(api);
  });
  const setup = within(await screen.findByRole("region", { name: setupName }));
  await userEvent.click(setup.getByRole("combobox", { name: "Endpoint" }));
  await userEvent.click(await screen.findByRole("option", { name: "Anthropic" }));
  await userEvent.type(setup.getByLabelText("Key"), "sk-ant");
  await userEvent.click(setup.getByRole("button", { name: "Save key" }));
  await waitFor(() =>
    expect(spade.sent("PATCH", "/v1/agents/main")).toEqual([
      { model: "anthropic/claude-sonnet-5-5" },
    ]),
  );
  expect(spade.sent("PUT", "/v1/keys/anthropic")).toEqual([{ key: "sk-ant" }]);
  await waitFor(() => expect(screen.queryByRole("region", { name: setupName })).toBeNull());
});

test("with a usable endpoint but Spade on one it can't reach, setup asks only for the model", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    withEndpoint(api);
    main(api);
  });
  const setup = within(await screen.findByRole("region", { name: setupName }));
  expect(setup.queryByLabelText("Key")).toBeNull();
  await userEvent.click(setup.getByRole("button", { name: "Model" }));
  await userEvent.click(await screen.findByRole("option", { name: /^Sonnet/ }));
  await userEvent.click(setup.getByRole("button", { name: "Use this model" }));
  await waitFor(() =>
    expect(spade.sent("PATCH", "/v1/agents/main")).toEqual([
      { model: "openrouter/anthropic/sonnet" },
    ]),
  );
  await waitFor(() => expect(screen.queryByRole("region", { name: setupName })).toBeNull());
});

test("while the keychain hasn't answered, a provider says its key is being checked, then that it's ready", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
    withEndpoint(api);
    api.keysPending = true;
    main(api, "openrouter/saved/model");
  });
  const openrouter = within(await screen.findByRole("group", { name: "OpenRouter" }));
  // The list is there at once; only the key waits, and it asks for nothing meanwhile.
  expect(await openrouter.findByText("Checking the keychain…")).toBeTruthy();
  expect(openrouter.queryByRole("button", { name: /key/ })).toBeNull();
  spade.keysPending = false;
  expect(await openrouter.findByText("Ready")).toBeTruthy();
});

test("Spade never asks for a key the keychain may still hold", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    withEndpoint(api);
    api.keysPending = true;
    main(api, "openrouter/saved/model");
  });
  await waitFor(() => expect(spade.sent("GET", "/v1/models").length).toBeGreaterThan(0));
  await screen.findByRole("feed");
  expect(screen.queryByRole("region", { name: setupName })).toBeNull();
});

test("sending is held until a model is chosen, with one line and a way to set one up", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    api.presets.push(opencode);
    main(api, "");
  });
  const held = await screen.findByText("Spade needs a model before it can answer.");
  const field = await screen.findByRole("combobox", { name: "Message Spade" });
  await userEvent.type(field, "hello{Enter}");
  expect(spade.sent("POST", "/v1/conversations/c-main/messages")).toEqual([]);
  // Set up a model takes the person to the first-run card, its first control ready.
  await userEvent.click(
    within(held.parentElement ?? document.body).getByRole("button", {
      name: "Set up a model",
    }),
  );
  const setup = within(screen.getByRole("region", { name: setupName }));
  expect(setup.getByRole("combobox", { name: "Endpoint" })).toBe(document.activeElement);
});

test("first run names each service plainly once, and adds a local server by its address", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    api.presets.push(opencode, {
      ...opencode,
      id: "go-anthropic",
      name: "OpenCode Go (Anthropic format)",
    });
    api.presets.push({ ...anthropic, id: "google", name: "Google Gemini (OpenAI format)" });
    api.liveModels.set("local-server", [{ id: "llama3" }]);
    main(api, "");
  });
  const setup = within(await screen.findByRole("region", { name: setupName }));
  await userEvent.click(setup.getByRole("combobox", { name: "Endpoint" }));
  const offered = (await screen.findAllByRole("option")).map((option) => option.textContent);
  expect(offered).toEqual(["OpenCode Go", "Google Gemini", "Custom or local server"]);
  await userEvent.click(screen.getByRole("option", { name: "Custom or local server" }));
  await userEvent.type(setup.getByLabelText("Address"), "http://localhost:11434/v1");
  await userEvent.click(setup.getByRole("button", { name: "Add server" }));
  await waitFor(() =>
    expect(spade.sent("PATCH", "/v1/agents/main")).toEqual([{ model: "local-server/llama3" }]),
  );
  expect(spade.sent("POST", "/v1/endpoints")).toEqual([
    {
      name: "Local server",
      format: "openai-chat",
      base_url: "http://localhost:11434/v1/",
      needs_key: false,
    },
  ]);
  expect(spade.sent("PUT", "/v1/keys/local-server")).toEqual([]);
});

test("Manage lists what the endpoint lists, with facts only where they are known, and saves one turned on", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
    withEndpoint(api);
    main(api, "openrouter/saved/model");
  });
  const models = await manageOpenRouter();
  await models.findByText("Sonnet");
  // Llama's list gave no tools, so none are claimed.
  const list = within(models.getByRole("list", { name: "Models" }));
  const items = list.getAllByRole("listitem");
  expect(items.map((row) => row.textContent)).toEqual([
    "Saved model",
    "Llama128K context",
    "Sonnet200K context·",
  ]);
  const [, llama, sonnet] = items;
  if (!llama || !sonnet) throw new Error("Expected Llama and Sonnet rows");
  expect(within(sonnet).getByRole("img", { name: "Images" })).toBeTruthy();
  expect(within(sonnet).getByRole("img", { name: "Tools" })).toBeTruthy();
  expect(within(llama).queryByRole("img", { name: "Tools" })).toBeNull();
  await userEvent.click(models.getByRole("switch", { name: "Llama on OpenRouter" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/endpoints/openrouter/models")).toEqual([
      { id: "meta/llama", name: "Llama", context: 128_000 },
    ]),
  );
});

/** Whether `b` comes after `a` in the page. */
const follows = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

test("Settings › Models reads in setup order: providers, Add a provider, then the roles", async () => {
  await spadeApp("/settings/spade/models", (api) => {
    withEndpoint(api);
    main(api, "openrouter/saved/model");
  });
  const provider = await screen.findByRole("group", { name: "OpenRouter" });
  const add = screen.getByRole("button", { name: "Add a provider" });
  const roles = await screen.findByRole("region", { name: "Roles" });
  expect(follows(provider, add)).toBe(true);
  expect(follows(add, roles)).toBe(true);
});
