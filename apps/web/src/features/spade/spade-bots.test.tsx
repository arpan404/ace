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
  await spadeApp("/spade", withSpade);
  await openNew("New bot");
  await userEvent.click(await screen.findByRole("button", { name: "More settings" }));
  await userEvent.click(await screen.findByRole("button", { name: "Model" }));
  const models = within(await screen.findByRole("listbox", { name: "Models" }));
  await models.findByRole("option", { name: /^Sonnet/ });
  // With no model for new bots set, the first choice leaves it to Spade.
  expect(models.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "First usable modelSaved model",
    "Saved model",
    "Llama128K context",
    "Sonnet200K context · images, tools",
  ]);
  expect(
    within(screen.getByRole("group", { name: "OpenRouter" })).getAllByRole("option"),
  ).toHaveLength(3);
  await userEvent.type(screen.getByRole("combobox", { name: "Search models" }), "qwen/qwen3-coder");
  await userEvent.click(await screen.findByRole("option", { name: "Use “qwen/qwen3-coder”" }));
  expect(screen.getByRole("button", { name: "Model" }).textContent).toBe(
    "qwen/qwen3-coder · OpenRouter",
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
  await userEvent.click(await screen.findByRole("button", { name: "Add an endpoint" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add endpoint" }));
  await choose(dialog, "From", "OpenCode Go");
  await userEvent.click(dialog.getByRole("button", { name: "Add endpoint" }));
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
  await userEvent.click(await screen.findByRole("button", { name: "Remove OpenRouter" }));
  // It asks once, saying the key goes too, then Spade's refusal shows where it was asked.
  expect(screen.getByText("Remove OpenRouter and its key?")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Spade, Inbox use this endpoint.");
  expect(spade.endpoints.map((endpoint) => endpoint.id)).toContain("openrouter");
});
