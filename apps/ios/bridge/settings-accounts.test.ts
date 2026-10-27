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

test("each provider offers every way its daemon can add an account", async () => {
  const { ask } = await open();
  const codex = await ask({ type: "accounts.screen", provider: "codex" });
  expect(labels(codex.screen.ways)).toEqual(["Sign in with the browser", "Use OpenAI API key"]);
  const claude = await ask({ type: "accounts.screen", provider: "claude" });
  expect(labels(claude.screen.ways)).toEqual(["Sign in with the browser"]);
  const antigravity = await ask({ type: "accounts.screen", provider: "antigravity" });
  expect(antigravity.screen.ways).toMatchObject([
    { label: "Google account", cloud: false },
    { label: "Gemini Enterprise", cloud: true },
    { label: "Agent Platform", cloud: true },
  ]);
});

test("adding an account starts its sign-in, and a cloud sign-in needs its project first", async () => {
  const { ask } = await open();
  const added = await ask({
    type: "accounts.screen.add",
    provider: "codex",
    label: "Work",
    shortLabel: "WK",
    way: { method: "api_key" },
  });
  expect(added.ok).toBe(true);
  expect(added.progress).toMatchObject({ provider: "codex", method: "api_key" });

  expect(
    await ask({
      type: "accounts.screen.add",
      provider: "antigravity",
      label: "Team",
      way: { method: "login", signIn: "enterprise", project: "", location: "global" },
    }),
  ).toEqual({ ok: false, problem: "Enter the Google Cloud project ID, like my-project-123." });
  expect(
    await ask({
      type: "accounts.screen.add",
      provider: "codex",
      label: "  ",
      way: { method: "login" },
    }),
  ).toEqual({ ok: false, problem: "Give the account a name, like Work." });
  expect(
    await ask({
      type: "accounts.screen.add",
      provider: "codex",
      label: "Work",
      shortLabel: "ABC",
      way: { method: "login" },
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
