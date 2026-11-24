import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { formatKeys } from "@/lib/keymap.ts";
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
  await userEvent.click(await screen.findByRole("button", { name: "Add a provider" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add a provider" }));
  const found = within(await dialog.findByRole("region", { name: "On this computer" }));
  expect(found.getByText("Runs on this computer · 2 models")).toBeTruthy();
  expect(found.getByText("gemma3:4b, qwen3:8b")).toBeTruthy();
  expect(found.getByText("Not running on this computer")).toBeTruthy();
  await userEvent.click(found.getByRole("button", { name: "Use" }));
  await userEvent.click(dialog.getByRole("button", { name: "Add provider" }));
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
  await userEvent.click(await screen.findByRole("button", { name: "Add a provider" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add a provider" }));
  await userEvent.click(dialog.getByRole("combobox", { name: "From" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "LM Studio (on this computer)" }),
  );
  await userEvent.click(dialog.getByRole("button", { name: "Add provider" }));
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
  // A new bot's model is at the top of its page, with how it runs.
  await userEvent.click(await screen.findByRole("button", { name: "Model" }));
  await userEvent.click(await screen.findByRole("tab", { name: "On this computer" }));
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
  // A new bot's model is at the top of its page, with how it runs.
  await userEvent.click(await screen.findByRole("button", { name: "Model" }));
  await userEvent.click(await screen.findByRole("tab", { name: "On this computer" }));
  const local = within(await screen.findByRole("group", { name: "On this computer" }));
  await userEvent.click(local.getByRole("option", { name: /^gemma3:4b/ }));
  // The checks run, then the picker says why it can't run a bot and keeps the choice as it was.
  const why = "This model didn't call tools in Spade's check, so it can't run a bot.";
  expect(await screen.findByText(why)).toBeTruthy();
  expect(screen.getByText("Didn't call tools · titles and summaries only")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Model" }).textContent).not.toContain("gemma3:4b");
  // Listed again, it reads why, and picking it doesn't choose it.
  const ollama = within(await screen.findByRole("group", { name: "Ollama" }));
  const option = ollama.getByRole("option", { name: /^gemma3:4b/ });
  expect(option.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(option);
  expect(screen.getByRole("button", { name: "Model" }).textContent).not.toContain("gemma3:4b");
  expect(spade.sent("POST", "/v1/endpoints/local/ollama")).toEqual([{ model: "gemma3:4b" }]);
});

test("a local model that failed its tool check has no ⌘ number, and ⌘1 picks the next one", async () => {
  await spadeApp("/spade", (here) => {
    here.endpoints.push({
      id: "ollama",
      name: "Ollama",
      format: "openai-chat",
      base_url: "http://127.0.0.1:11434/v1/",
      local: true,
      header_names: [],
      session_header: null,
      needs_key: false,
      key_set: false,
      key_source: null,
      models: [
        {
          id: "gemma3:4b",
          name: "gemma3:4b",
          probes: {
            state: "checked",
            plain: "passed",
            tools: "failed",
            structured: "passed",
            why: "This model didn't call tools in Spade's check, so it can't run a bot.",
          },
        },
        { id: "qwen3:8b", name: "qwen3:8b" },
      ],
    });
    here.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  });
  await openNew("New bot");
  await userEvent.click(await screen.findByRole("button", { name: "Model" }));
  await userEvent.click(await screen.findByRole("tab", { name: "Ollama" }));
  const local = within(await screen.findByRole("group", { name: "Ollama" }));
  const failed = local.getByRole("option", { name: /^gemma3:4b/ }).parentElement;
  const usable = local.getByRole("option", { name: /^qwen3:8b/ }).parentElement;
  if (!failed || !usable) throw new Error("Expected the picker's rows");
  // The failed model can't be picked, so it has no slot; qwen3 takes the first one.
  expect(within(failed).queryByText(formatKeys("mod+1"))).toBeNull();
  expect(within(usable).getByText(formatKeys("mod+1"))).toBeTruthy();
  await userEvent.click(screen.getByRole("combobox", { name: "Search models" }));
  await userEvent.keyboard("{Control>}1{/Control}");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("qwen3:8b"),
  );
});

test("Shift+Tab from the search field still moves focus when there is no model source rail", async () => {
  await spadeApp("/settings/spade/models", (api) => {
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" }, model: "" });
  });
  const roles = within(await screen.findByRole("region", { name: "Roles" }));
  await userEvent.click(await roles.findByRole("button", { name: "Helpers" }));
  const search = await screen.findByRole("combobox", { name: "Search models" });
  expect(document.activeElement).toBe(search);
  await userEvent.tab({ shift: true });
  expect(document.activeElement).not.toBe(search);
});

test("Settings says what Spade's checks found on a local model, and Check again runs them", async () => {
  const { spade } = await spadeApp("/settings/spade/models", (here) => {
    withLocal(here);
    here.endpoints.unshift({
      id: "ollama",
      name: "Ollama",
      format: "openai-chat",
      base_url: "http://127.0.0.1:11434/v1/",
      local: true,
      header_names: [],
      session_header: null,
      needs_key: false,
      key_set: false,
      key_source: null,
      models: [
        {
          id: "gemma3:1b",
          name: "Gemma 3 1B",
          capabilities: [],
          source: "listed",
          probes: {
            state: "checked",
            plain: "passed",
            tools: "failed",
            structured: "passed",
            why: "This model didn't call tools in Spade's check, so it can't run a bot.",
          },
        },
      ],
    });
  });
  // Its provider's row on the list opens its page, where the check's finding leads the models.
  await userEvent.click(await screen.findByRole("link", { name: "Ollama" }));
  const ollama = within(await screen.findByRole("list", { name: "Model problems" }));
  expect(
    ollama.getByText("This model didn't call tools in Spade's check, so it can't run a bot."),
  ).toBeTruthy();
  await userEvent.click(ollama.getByRole("button", { name: "Check Gemma 3 1B again" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/endpoints/ollama/probe")).toEqual([{ id: "gemma3:1b" }]),
  );
  expect(await ollama.findByText("Checking what it can do…")).toBeTruthy();
});
