import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const main = (spade: FakeSpadeApi) =>
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
const opencode = {
  id: "opencode-go",
  name: "OpenCode Go",
  format: "openai-chat",
  base_url: "https://opencode.ai/zen/go/v1/",
  key_env: "OPENCODE_API_KEY",
  session_header: "x-opencode-session",
};

test("a local endpoint can be added without a key", async () => {
  const { spade } = await spadeApp("/settings/spade", (api) => {
    withEndpoint(api);
    main(api);
  });
  await userEvent.click(await screen.findByRole("button", { name: "Add endpoint" }));
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
  const setup = within(await screen.findByRole("region", { name: "Model key" }));
  expect(
    setup.getByText(
      /^This machine has no keychain for Spade to keep keys in\. Set OPENCODE_API_KEY/,
    ),
  ).toBeTruthy();
  expect(setup.queryByRole("button", { name: "Save key" })).toBeNull();
});

test("an endpoint made while saving its key stays made: trying again sets its key, never adds another", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    api.presets.push(opencode);
    api.keyFailure = 500;
    main(api);
  });
  const setup = within(await screen.findByRole("region", { name: "Model key" }));
  await userEvent.type(setup.getByLabelText("Key"), "sk-1");
  await userEvent.click(setup.getByRole("button", { name: "Save key" }));
  expect((await setup.findByRole("alert")).textContent).toBe("The keychain refused the key.");
  spade.keyFailure = undefined;
  await userEvent.type(setup.getByLabelText("Key"), "sk-2");
  await userEvent.click(setup.getByRole("button", { name: "Save key" }));
  await waitFor(() => expect(spade.sent("PUT", "/v1/keys/opencode-go")).toHaveLength(2));
  expect(spade.sent("POST", "/v1/endpoints")).toHaveLength(1);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Model key" })).toBeNull());
});

test("only the person's saved models can be removed; the preset's have no Remove", async () => {
  await spadeApp("/settings/spade", (api) => {
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
