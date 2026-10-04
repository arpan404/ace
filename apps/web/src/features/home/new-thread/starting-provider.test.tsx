import { workbench } from "@ace/fake-daemon";
import type { KeyValueStorage } from "@ace/ui-core";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

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

async function send(text: string) {
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), `${text}{Enter}`);
  await screen.findByRole("heading", { level: 1, name: text });
}

test("New thread starts on the last-used provider", async () => {
  const storage = memoryKeyValue();
  await app(storage).open("/new?project=relay");
  expect((await model()).getAttribute("aria-label")).toMatch(/^Model: Opus 4\.1/);
  await userEvent.click(await model());
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "GPT-5 Codex" }));
  await send("Log every restart with its backoff delay");
  cleanup();

  await app(storage).open("/new?project=relay");
  expect((await model()).getAttribute("aria-label")).toMatch(/^Model: GPT-5 Codex/);
});

test("New thread falls back to the first installed, logged-in provider", async () => {
  const made = app();
  const { services } = made.daemon;
  services.installed.delete("claude");
  for (const account of services.accounts)
    if (account.provider === "codex") {
      account.availability = "logged_out";
      account.quota.auth = "logged_out";
    }
  await made.open("/new?project=relay");

  // Claude Code isn't installed and every Codex account is signed out: OpenCode is next.
  expect((await model()).getAttribute("aria-label")).toMatch(/^Model: Sonnet 4\.5 \(OpenCode\)/);
});

test("on a daemon without a model catalog, New thread starts on the installed CLI, not Claude Code", async () => {
  const made = app();
  const { services } = made.daemon;
  services.models = [];
  services.accounts = [];
  services.installed = new Set(["codex"]);
  await made.open("/new?project=relay");

  expect((await model()).getAttribute("aria-label")).toBe("Model: Codex default");
  await userEvent.click(await model());
  expect(screen.queryByRole("menuitemradio", { name: "Claude Code default" })).toBeNull();
  await userEvent.keyboard("{Escape}");

  await send("Explain the restart backoff");
  const created = listed(made).find((thread) => thread.title === "Explain the restart backoff");
  expect(created).toMatchObject({ provider: "codex" });
});

test("the default provider picked in Settings wins over the last-used one", async () => {
  const storage = memoryKeyValue();
  await app(storage).open("/new?project=relay");
  expect((await model()).getAttribute("aria-label")).toMatch(/^Model: Opus 4\.1/);
  await send("Log every restart with its backoff delay");
  cleanup();

  const made = app(storage);
  made.daemon.services.settings.seed({ "providers.default": "codex" });
  await made.open("/new?project=relay");
  expect((await model()).getAttribute("aria-label")).toMatch(/^Model: GPT-5 Codex/);
});

test("with no provider CLI installed, New thread says so instead of loading forever", async () => {
  const made = app();
  made.daemon.services.installed = new Set();
  made.daemon.services.accounts = [];
  made.daemon.services.models = [];
  await made.open("/new?project=relay");

  expect(await screen.findByRole("button", { name: "Model: no provider installed" })).toBeTruthy();
});
