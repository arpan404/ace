import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { openNew, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** Ollama running with two models, LM Studio not running: as Spade finds them. */
const withLocal = (spade: FakeSpadeApi) => {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  spade.localServers = [
    {
      id: "ollama",
      name: "Ollama",
      base_url: "http://127.0.0.1:11434/v1/",
      running: true,
      models: ["gemma3:4b", "qwen3:8b"],
      endpoint: null,
    },
    {
      id: "lmstudio",
      name: "LM Studio",
      base_url: "http://127.0.0.1:1234/v1/",
      running: false,
      models: [],
      endpoint: null,
    },
  ];
};

test("Add endpoint shows a running Ollama with its models, and Use adds it with no key", async () => {
  const { spade } = await spadeApp("/settings/spade/models", withLocal);
  await userEvent.click(await screen.findByRole("button", { name: "Add an endpoint" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add endpoint" }));
  const found = within(await dialog.findByRole("region", { name: "On this computer" }));
  expect(found.getByText("Runs on this computer · 2 models")).toBeTruthy();
  expect(found.getByText("gemma3:4b, qwen3:8b")).toBeTruthy();
  expect(found.getByText("Not running on this computer")).toBeTruthy();
  await userEvent.click(found.getByRole("button", { name: "Use" }));
  await userEvent.click(dialog.getByRole("button", { name: "Add endpoint" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/endpoints")).toEqual([
      {
        name: "Ollama",
        format: "openai-chat",
        base_url: "http://127.0.0.1:11434/v1/",
        needs_key: false,
      },
    ]),
  );
});

test("LM Studio is offered under From even when it isn't running, filled in with no key", async () => {
  const { spade } = await spadeApp("/settings/spade/models", withLocal);
  await userEvent.click(await screen.findByRole("button", { name: "Add an endpoint" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add endpoint" }));
  await userEvent.click(dialog.getByRole("combobox", { name: "From" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "LM Studio (on this computer)" }),
  );
  await userEvent.click(dialog.getByRole("button", { name: "Add endpoint" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/endpoints")).toEqual([
      {
        name: "LM Studio",
        format: "openai-chat",
        base_url: "http://127.0.0.1:1234/v1/",
        needs_key: false,
      },
    ]),
  );
});

test("the model picker offers a running Ollama's models, and picking one chooses it", async () => {
  const { spade } = await spadeApp("/spade", withLocal);
  await openNew("New bot");
  await userEvent.click(await screen.findByRole("button", { name: "More settings" }));
  await userEvent.click(await screen.findByRole("button", { name: "Model" }));
  const local = within(await screen.findByRole("group", { name: "On this computer" }));
  await userEvent.click(local.getByRole("option", { name: /^qwen3:8b/ }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/endpoints/local/ollama")).toEqual([{ model: "qwen3:8b" }]),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Model" }).textContent).toBe("qwen3:8b · Ollama"),
  );
});

test("a local model that didn't call tools in Spade's check isn't taken as a bot's model", async () => {
  const { spade } = await spadeApp("/spade", (here) => {
    withLocal(here);
    here.localChecks.set("gemma3:4b", "failed");
  });
  await openNew("New bot");
  await userEvent.click(await screen.findByRole("button", { name: "More settings" }));
  await userEvent.click(await screen.findByRole("button", { name: "Model" }));
  const local = within(await screen.findByRole("group", { name: "On this computer" }));
  await userEvent.click(local.getByRole("option", { name: /^gemma3:4b/ }));
  // The checks run, then the picker says why it can't run a bot and keeps the choice as it was.
  const why = "This model didn't call tools in Spade's check, so it can't run a bot.";
  expect(await screen.findAllByText(why)).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Model" }).textContent).not.toContain("gemma3:4b");
  // Listed again, it reads why, and picking it doesn't choose it.
  const ollama = within(await screen.findByRole("group", { name: "Ollama" }));
  const option = ollama.getByRole("option", { name: /^gemma3:4b/ });
  expect(option.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(option);
  expect(screen.getByRole("button", { name: "Model" }).textContent).not.toContain("gemma3:4b");
  expect(spade.sent("POST", "/v1/endpoints/local/ollama")).toEqual([{ model: "gemma3:4b" }]);
});
