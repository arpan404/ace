import { workbench } from "@ace/fake-daemon";
import type { KeyValueStorage } from "@ace/ui-core";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { chooseModel, closeModelControl } from "@/test/model-control.ts";

/** A daemon where the person never picked a default provider in Settings. */
function app(storage: KeyValueStorage = memoryKeyValue()) {
  const made = harness({ storage });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  made.daemon.services.settings.unset("providers.default");
  return made;
}
const listed = (made: ReturnType<typeof harness>) => {
  const view = made.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? Object.values(view.threads) : [];
};
const model = () => screen.findByRole("button", { name: /^Model: / });
/** The thread this page started, once its create lands (its id is made from the command's). */
const isNew = (id: string) => /^thread-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id);

async function send(text: string) {
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), `${text}{Enter}`);
  await screen.findByRole("heading", { level: 1, name: text });
}

test("New thread starts on the last-used provider", async () => {
  const storage = memoryKeyValue();
  await app(storage).open("/new?project=relay");
  expect((await model()).getAttribute("aria-label")).toMatch(/^Model: Opus 5\.5/);
  await chooseModel("GPT-5 Codex", "Codex");
  await closeModelControl();
  await send("Log every restart with its backoff delay");
  cleanup();

  await app(storage).open("/new?project=relay");
  expect((await model()).getAttribute("aria-label")).toMatch(/^Model: GPT-5 Codex/);
});

test("New thread falls back to the first installed, logged-in provider", async () => {
  const made = app();
  const { services } = made.daemon;
  services.installed.delete("claude");
  const claude = services.providerStatuses.find((status) => status.provider === "claude");
  if (!claude) throw new Error("Missing Claude discovery");
  claude.installed = false;
  for (const account of services.accounts)
    if (account.provider === "codex") {
      account.availability = "logged_out";
      account.quota.auth = "logged_out";
    }
  // Codex's own login doesn't vouch for it either.
  const codex = services.providerStatuses.find((status) => status.provider === "codex");
  if (codex) codex.auth = "unknown";
  await made.open("/new?project=relay");

  // Claude Code isn't installed and every Codex account is signed out: OpenCode is next.
  expect((await model()).getAttribute("aria-label")).toMatch(/^Model: Muse Spark/);
});

test("an installed CLI whose catalog lists no models shows an empty state, not a made-up default", async () => {
  const made = app();
  const { services } = made.daemon;
  services.models = [];
  services.installed = new Set(["codex"]);
  for (const status of services.providerStatuses) status.installed = status.provider === "codex";
  await made.open("/new?project=relay");

  const chip = await screen.findByRole("button", { name: "Model: no models available" });
  expect(chip.textContent).toBe("No models available");

  // Nothing to start on: the message stays in the composer and no thread is created.
  const field = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(field, "Explain the restart backoff{Enter}");
  // The composer empties on Enter; a message that wasn't started comes back into it.
  await waitFor(async () => {
    const restored = await screen.findByRole("combobox", { name: "Message" });
    if (!(restored instanceof HTMLTextAreaElement)) throw new Error("Expected message textarea");
    expect(restored.value).toBe("Explain the restart backoff");
  });
  expect(listed(made).some((thread) => isNew(thread.id))).toBe(false);
});

test("the default provider picked in Settings wins over the last-used one", async () => {
  const storage = memoryKeyValue();
  await app(storage).open("/new?project=relay");
  expect((await model()).getAttribute("aria-label")).toMatch(/^Model: Opus 5\.5/);
  await send("Log every restart with its backoff delay");
  cleanup();

  const made = app(storage);
  made.daemon.services.settings.seed({ "providers.default": "codex" });
  await made.open("/new?project=relay");
  expect((await model()).getAttribute("aria-label")).toMatch(/^Model: GPT-6\.1 Sol/);
});

test("with no provider CLI installed, New thread says so instead of loading forever", async () => {
  const made = app();
  made.daemon.services.installed = new Set();
  for (const status of made.daemon.services.providerStatuses) status.installed = false;
  made.daemon.services.accounts = [];
  made.daemon.services.models = [];
  await made.open("/new?project=relay");

  expect(await screen.findByRole("button", { name: "Model: no provider installed" })).toBeTruthy();
});
