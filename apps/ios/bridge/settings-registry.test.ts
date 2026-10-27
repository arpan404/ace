import "./test-host.ts";
import type { ClientCore } from "@ace/client";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { answerSettingsManage, SettingsManageRequest } from "./settings-manage.ts";
import { settingsFixture } from "./settings-fixture.ts";

/*
 * Settings' ACP registry on the phone over the real SDK and an in-process fake daemon: the list
 * and search in the web's words, an entry's install plan, an install through the provider
 * installer, and an agent added by its command.
 */

let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

// Bridge answers are untyped JSON for Swift; the tests read them as such.
// oxlint-disable-next-line typescript/no-explicit-any
type Answer = Record<string, any>;

async function open() {
  const fixture = await settingsFixture();
  client = fixture.owner;
  const ask = async (request: z.input<typeof SettingsManageRequest>) =>
    (await answerSettingsManage(
      fixture.owner,
      SettingsManageRequest.parse(request),
      new AbortController().signal,
    )) as Answer;
  return { ...fixture, ask };
}

test("the registry lists every agent with where it stands here, and search narrows it", async () => {
  const { ask } = await open();
  const all = await ask({ type: "acp.registry", query: "" });
  expect(all.ok).toBe(true);
  const rows = all.screen.rows as { name: string; standing: string | null; unavailable: boolean }[];
  expect(rows.find((row) => row.name === "Gemini CLI")).toMatchObject({
    standing: "Update available",
  });
  expect(rows.find((row) => row.name === "Amp")?.standing).toBeNull();
  // What can't install here sorts last.
  const firstUnavailable = rows.findIndex((row) => row.unavailable);
  expect(firstUnavailable).toBeGreaterThan(0);
  expect(rows.slice(firstUnavailable).every((row) => row.unavailable)).toBe(true);
  expect(all.screen.age).toMatch(/^Updated /);

  const found = await ask({ type: "acp.registry", query: "gemini" });
  expect(found.screen.rows[0].name).toBe("Gemini CLI");
  const none = await ask({ type: "acp.registry", query: "zzzz" });
  expect(none.screen).toMatchObject({
    rows: [],
    empty: "No agents match “zzzz”.",
    noMatch: true,
  });
  expect(all.screen.noMatch).toBe(false);
});

test("a refresh that can't reach the registry keeps the saved list and says so", async () => {
  const { ask, daemon } = await open();
  daemon.services.registry.refreshFails = true;
  daemon.services.registry.stepMs = 1;
  expect(await ask({ type: "acp.registry.refresh" })).toMatchObject({ ok: false });
  const after = await ask({ type: "acp.registry", query: "" });
  expect(after.screen.age).toBe("Couldn't reach the registry · Showing the saved list");
  expect(after.screen.rows.length).toBeGreaterThan(0);
});

test("an agent's page shows its install plan and set-up, then installs and joins the list", async () => {
  const { ask } = await open();
  const page = await ask({ type: "acp.registry.agent", acpAgentId: "official:amp-acp" });
  expect(page.agent).toMatchObject({ name: "Amp", action: "install", actionLabel: "Install" });
  expect(page.agent.facts.map((fact: { label: string }) => fact.label)).toEqual(
    expect.arrayContaining(["Installs", "From", "Runtime", "Verified by"]),
  );

  const started = await ask({
    type: "acp.registry.install",
    acpAgentId: "official:amp-acp",
    action: "install",
  });
  expect(started.ok).toBe(true);
  let install = started.install;
  for (let tries = 0; !install.finished && tries < 100; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    install = (await ask({ type: "acp.registry.progress", session: install.session })).install;
  }
  expect(install).toMatchObject({ finished: true, succeeded: true, title: "Installed" });
  const list = await ask({ type: "acp.registry", query: "amp" });
  expect(list.screen.rows[0]).toMatchObject({ name: "Amp", standing: "Installed" });
});

test("an installed, current agent offers nothing to install", async () => {
  const { ask, daemon } = await open();
  const gemini = daemon.services.registry.installations[0];
  if (gemini) gemini.version = "0.63.0";
  const page = await ask({ type: "acp.registry.agent", acpAgentId: "official:gemini" });
  expect(page.agent).toMatchObject({ action: null, standing: "Installed", facts: [] });
  expect(page.agent.setup).toEqual({ run: "gemini", prompt: null, note: null });
});

test("add by command is offered but never binds, as the web does against a daemon", async () => {
  const { ask, daemon } = await open();
  const before = daemon.services.registry.installations.length;
  expect(await ask({ type: "acp.manual" })).toEqual({
    ok: true,
    manual: { canAdd: false, note: "This daemon can't add agents by command yet." },
  });
  // Nothing a person could do on the page reaches the daemon's local bindings.
  expect(daemon.services.registry.installations).toHaveLength(before);
  expect(() =>
    SettingsManageRequest.parse({ type: "acp.manual.add", name: "Mine", command: "fake-acp" }),
  ).toThrow();
});
