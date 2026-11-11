import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const withSpade = (spade: FakeSpadeApi) => {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
};

async function newBot() {
  await userEvent.click(await screen.findByRole("button", { name: "New bot" }));
  return within(await screen.findByRole("dialog", { name: "New bot" }));
}

async function choose(scope: ReturnType<typeof within>, select: string, option: string) {
  await userEvent.click(scope.getByRole("combobox", { name: select }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("the model picker lists what the endpoint serves with its facts, and takes a typed id", async () => {
  await spadeApp("/spade", withSpade);
  const form = await newBot();
  await userEvent.click(await form.findByRole("button", { name: "Model" }));
  const models = within(await screen.findByRole("listbox", { name: "Models" }));
  await models.findByRole("option", { name: /^Sonnet/ });
  expect(models.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "Saved model",
    "Llama128K context",
    "Sonnet200K context · images, tools",
  ]);
  await userEvent.type(screen.getByRole("textbox", { name: "Search models" }), "qwen/qwen3-coder");
  await userEvent.click(
    await screen.findByRole("option", { name: "Use “qwen/qwen3-coder” as the model id" }),
  );
  expect(form.getByRole("button", { name: "Model" }).textContent).toBe("qwen/qwen3-coder");
});

test("New bot creates the bot on the machine chosen for it and opens its conversation", async () => {
  const { others, spade } = await spadeApp("/spade", withSpade, {
    machines: [{ hostId: "studio", name: "Studio Mac", seed: withEndpoint }],
  });
  const form = await newBot();
  await userEvent.type(form.getByRole("textbox", { name: "Name" }), "Travel");
  await userEvent.type(form.getByRole("textbox", { name: "Task" }), "Plan and book my trips");
  await userEvent.click(form.getByRole("radio", { name: "violet" }));
  await choose(form, "Runs on", "Studio Mac");
  await userEvent.click(form.getByRole("button", { name: "Model" }));
  await userEvent.click(await screen.findByRole("option", { name: /^Sonnet/ }));
  await userEvent.click(form.getByRole("button", { name: "Create bot" }));
  const studio = others.get("studio");
  await waitFor(() =>
    expect(studio?.sent("POST", "/v1/agents")).toEqual([
      {
        name: "Travel",
        task: "Plan and book my trips",
        model: "openrouter/anthropic/sonnet",
        avatar: { kind: "generated", color: "violet" },
      },
    ]),
  );
  expect(spade.sent("POST", "/v1/agents")).toEqual([]);
  await screen.findByRole("feed", { name: "Conversation with Travel" });
  expect((await botRow("Travel")).getAttribute("aria-current")).toBe("page");
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
    expect((await botRow("Research")).textContent).toContain("Away · Studio Mac is offline"),
  );
});

test("with no endpoint key, Spade's conversation asks for one and saves it to Spade", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    withEndpoint(api);
    const [endpoint] = api.endpoints;
    if (endpoint) endpoint.key_set = false;
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  });
  const setup = within(await screen.findByRole("region", { name: "Model key" }));
  expect(setup.getByText("Spade needs a key for one of your model endpoints to answer.")).toBeTruthy();
  await userEvent.type(setup.getByLabelText("Key"), "sk-test");
  await userEvent.click(setup.getByRole("button", { name: "Save key" }));
  await waitFor(() => expect(spade.sent("PUT", "/v1/keys/openrouter")).toEqual([{ key: "sk-test" }]));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Model key" })).toBeNull());
});

test("an endpoint added from a preset reaches Spade, and one bots still use can't be removed", async () => {
  const { spade } = await spadeApp("/settings/spade", (api) => {
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
  await userEvent.click(await screen.findByRole("button", { name: "Add endpoint" }));
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
  const openrouter = within(await screen.findByRole("region", { name: "OpenRouter" }));
  await userEvent.click(openrouter.getByRole("button", { name: "Remove OpenRouter" }));
  expect((await openrouter.findByRole("alert")).textContent).toBe("Inbox use this endpoint.");
  expect(spade.endpoints.map((endpoint) => endpoint.id)).toContain("openrouter");
});
