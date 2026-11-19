import "./test-host.ts";
import type { ClientCore } from "@ace/client";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { answerSettingsManage, SettingsManageRequest } from "./settings-manage.ts";
import { settingsFixture } from "./settings-fixture.ts";

/*
 * A provider's accounts on the phone over the real SDK and an in-process fake daemon: every way
 * the daemon adds one, which accounts can take their files with them on remove, and the badge
 * preview the editor shows while it's edited.
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

const labels = (ways: { label: string }[]) => ways.map((way) => way.label);

test("each provider offers its sign-in ways and never asks for an API key on the phone", async () => {
  const { ask } = await open();
  const codex = (await ask({ type: "accounts.screen", provider: "codex" })).screen;
  expect(labels(codex.ways)).toEqual(["Sign in with the browser"]);
  expect(labels(codex.reauth)).toEqual(["Sign in again"]);
  // Codex takes keys, but only through ace on the computer (ADR 0002's provider_auth channel).
  expect(codex.apiKey).toMatch(/^Add an API key in ace on .+\.$/);
  const claude = (await ask({ type: "accounts.screen", provider: "claude" })).screen;
  expect(labels(claude.ways)).toEqual(["Sign in with the browser"]);
  expect(claude.apiKey).toBeNull();
  const opencode = (await ask({ type: "accounts.screen", provider: "opencode" })).screen;
  expect(labels(opencode.reauth)).toEqual(["Sign in again"]);
  const antigravity = (await ask({ type: "accounts.screen", provider: "antigravity" })).screen;
  expect(antigravity.ways).toMatchObject([
    { label: "Google account", cloud: false },
    { label: "Gemini Enterprise", cloud: true },
    { label: "Agent Platform", cloud: true },
  ]);
  for (const screen of [codex, claude, opencode, antigravity])
    expect(JSON.stringify([screen.ways, screen.reauth])).not.toMatch(/api.?key|upstream/i);
});

test("adding an account starts a browser sign-in, even when a request names a key method", async () => {
  const { ask } = await open();
  const added = await ask({
    type: "accounts.screen.add",
    provider: "codex",
    label: "Work",
    shortLabel: "WK",
    // Stray fields from an older caller are dropped by the schema; only login is ever sent.
    way: { method: "api_key", upstream: "openai" } as never,
  });
  expect(added.ok).toBe(true);
  expect(added.progress).toMatchObject({ provider: "codex" });
  expect(added.progress.method ?? "login").toBe("login");
});

test("a cloud sign-in needs its project first, and a name and usable badge are required", async () => {
  const { ask } = await open();
  expect(
    await ask({
      type: "accounts.screen.add",
      provider: "antigravity",
      label: "Team",
      way: { signIn: "enterprise", project: "", location: "global" },
    }),
  ).toEqual({ ok: false, problem: "Enter the Google Cloud project ID, like my-project-123." });
  expect(
    await ask({ type: "accounts.screen.add", provider: "codex", label: "  ", way: {} }),
  ).toEqual({ ok: false, problem: "Give the account a name, like Work." });
  expect(
    await ask({
      type: "accounts.screen.add",
      provider: "codex",
      label: "Work",
      shortLabel: "ABC",
      way: {},
    }),
  ).toEqual({ ok: false, problem: "Use up to two letters, or pick an icon." });
});

test("only accounts with their own sign-in folder offer to delete their files on remove", async () => {
  const { ask } = await open();
  for (const provider of ["codex", "opencode"] as const) {
    const screen = (await ask({ type: "accounts.screen", provider })).screen;
    const removable = (screen.accounts as { removable: boolean; canDeleteFiles: boolean }[]).filter(
      (account) => account.removable,
    );
    expect(removable.length).toBeGreaterThan(0);
    expect(removable.every((account) => account.canDeleteFiles === (provider === "codex"))).toBe(
      true,
    );
  }
});

test("the badge preview follows each edit and says when it can't be saved", async () => {
  const { ask } = await open();
  expect(
    await ask({ type: "accounts.screen.badge", label: "Work", shortLabel: "", color: "blue" }),
  ).toMatchObject({ ok: true, badge: { text: "W", color: "blue", problem: null } });
  expect(
    await ask({ type: "accounts.screen.badge", label: "Work", shortLabel: "😀", icon: "rocket" }),
  ).toMatchObject({ badge: { text: "?", icon: "rocket", problem: expect.any(String) } });
});

test("an account's name and badge are saved together, and a bad badge is refused first", async () => {
  const { ask } = await open();
  const before = (await ask({ type: "accounts.screen", provider: "codex" })).screen.accounts[0];
  expect(
    await ask({
      type: "accounts.screen.rename",
      provider: "codex",
      instanceId: before.id,
      label: "Work",
      shortLabel: "",
      color: "violet",
      icon: "rocket",
    }),
  ).toEqual({ ok: true });
  const after = (await ask({ type: "accounts.screen", provider: "codex" })).screen.accounts[0];
  expect(after).toMatchObject({ label: "Work", badge: { icon: "rocket", color: "violet" } });
  expect(
    await ask({
      type: "accounts.screen.rename",
      provider: "codex",
      instanceId: before.id,
      label: "Work",
      shortLabel: "ABC",
    }),
  ).toEqual({ ok: false, problem: "Use up to two letters, or pick an icon." });
});

test("removing with its files asks the daemon to delete the account's folder", async () => {
  const { ask } = await open();
  const screen = (await ask({ type: "accounts.screen", provider: "codex" })).screen;
  const account = screen.accounts.find((row: { removable: boolean }) => row.removable);
  expect(
    await ask({
      type: "accounts.screen.act",
      provider: "codex",
      instanceId: account.id,
      action: "removeWithFiles",
    }),
  ).toEqual({ ok: true });
  const left = (await ask({ type: "accounts.screen", provider: "codex" })).screen.accounts;
  expect(left.map((row: { id: string }) => row.id)).not.toContain(account.id);
  // OpenCode keeps its sign-in in the CLI, so there are no files of ace's to delete.
  const opencode = (await ask({ type: "accounts.screen", provider: "opencode" })).screen;
  const own = opencode.accounts.find((row: { removable: boolean }) => row.removable);
  expect(
    await ask({
      type: "accounts.screen.act",
      provider: "opencode",
      instanceId: own.id,
      action: "removeWithFiles",
    }),
  ).toEqual({ ok: false, problem: "This provider can't do that." });
});
