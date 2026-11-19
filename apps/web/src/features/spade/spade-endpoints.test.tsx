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
  await userEvent.click(await screen.findByRole("button", { name: "Add an endpoint" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add endpoint" }));
  await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "Ollama");
  await userEvent.type(
    dialog.getByRole("textbox", { name: "Base URL" }),
    "http://localhost:11434/v1/",
  );
  await userEvent.click(dialog.getByRole("switch", { name: "Needs a key" }));
  await userEvent.click(dialog.getByRole("button", { name: "Add endpoint" }));
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

test("only the person's saved models can be removed; the preset's have no Remove", async () => {
  await spadeApp("/settings/spade/models", (api) => {
    withEndpoint(api);
    const [endpoint] = api.endpoints;
    if (endpoint)
      endpoint.models = [
        { id: "saved/model", name: "Saved model", source: "typed" },
        { id: "preset/model", name: "Preset model", source: "preset" },
      ];
    main(api);
  });
  const openrouter = within(await screen.findByRole("region", { name: "OpenRouter" }));
  await openrouter.findByText("Preset model");
  expect(openrouter.getByRole("button", { name: "Remove Saved model" })).toBeTruthy();
  expect(openrouter.queryByRole("button", { name: "Remove Preset model" })).toBeNull();
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

test("while the keychain hasn't answered, an endpoint's key says it is being checked, then what it is", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
    withEndpoint(api);
    api.keysPending = true;
    main(api, "openrouter/saved/model");
  });
  const openrouter = within(await screen.findByRole("region", { name: "OpenRouter" }));
  // The list is there at once; only the key waits.
  expect(await openrouter.findByText("Checking the keychain…")).toBeTruthy();
  expect(openrouter.getByText("Saved model")).toBeTruthy();
  expect(openrouter.queryByText("Not saved")).toBeNull();
  spade.keysPending = false;
  expect(await openrouter.findByText("Saved in the keychain")).toBeTruthy();
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

test("Add a model offers what the endpoint lists, with facts only where they are known", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (api) => {
    withEndpoint(api);
    main(api, "openrouter/saved/model");
  });
  const openrouter = within(await screen.findByRole("region", { name: "OpenRouter" }));
  await userEvent.click(openrouter.getByRole("button", { name: "Add a model" }));
  const models = within(await screen.findByRole("listbox", { name: "Models" }));
  await models.findByRole("option", { name: /^Sonnet/ });
  // Saved ones aren't offered again; Llama's list gave no tools, so none are claimed.
  expect(models.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "Llama128K context",
    "Sonnet200K context · images, tools",
  ]);
  await userEvent.click(models.getByRole("option", { name: /^Llama/ }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/endpoints/openrouter/models")).toEqual([{ id: "meta/llama" }]),
  );
});

/** Whether `b` comes after `a` in the page. */
const follows = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

test("Settings › Models reads in setup order: endpoints, Add an endpoint, then other work", async () => {
  await spadeApp("/settings/spade/models", (api) => {
    withEndpoint(api);
    main(api, "openrouter/saved/model");
  });
  const endpoint = await screen.findByRole("region", { name: "OpenRouter" });
  const add = screen.getByRole("button", { name: "Add an endpoint" });
  const roles = await screen.findByRole("region", { name: "Models for other work" });
  expect(follows(endpoint, add)).toBe(true);
  expect(follows(add, roles)).toBe(true);
});
