import "./test-host.ts";
import type { ClientCore } from "@ace/client";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { settingsFixture } from "./settings-fixture.ts";
import {
  answerSourceControlScreen,
  changedPreferences,
  SourceControlScreenRequest,
} from "./source-control-screen.ts";

/*
 * Settings › Source control on the phone: saved hosts keep their provider and every field the
 * phone doesn't edit, and each host reads under its provider's name.
 */

let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

// Bridge answers are untyped JSON for Swift; the tests read them as such.
// oxlint-disable-next-line typescript/no-explicit-any
type Answer = Record<string, any>;

async function open(preferences: unknown) {
  const fixture = await settingsFixture();
  client = fixture.owner;
  const seeded = await fixture.owner.request({
    type: "settings.set",
    key: "sourceControl.preferences",
    layer: { kind: "global" },
    value: preferences,
  });
  expect(seeded.ok).toBe(true);
  const ask = async (request: z.input<typeof SourceControlScreenRequest>) =>
    (await answerSourceControlScreen(
      fixture.owner,
      SourceControlScreenRequest.parse(request),
      new AbortController().signal,
    )) as Answer;
  const saved = async () =>
    (
      await fixture.owner.request({
        type: "settings.get",
        key: "sourceControl.preferences",
        scope: {},
      })
    ).entries[0]?.value;
  return { ask, saved };
}

test("a host with an unknown field and provider survives a save of another host unchanged", () => {
  const gitlab = { host: "git.example.com", forge: "gitlab", account: "ada", note: { kept: 1 } };
  const future = { host: "code.example.org", forge: "sourcehut", token: "x" };
  const next = changedPreferences(
    { hosts: [{ host: "github.com" }, gitlab, future], host: "github.com", remote: "origin" },
    { kind: "host", original: "github.com", forge: "github", host: "github.com", account: "ada" },
  );
  expect(next).toEqual({
    value: {
      hosts: [{ host: "github.com", forge: "github", account: "ada" }, gitlab, future],
      host: "github.com",
      remote: "origin",
    },
  });
});

test("editing a host keeps its other fields and leaves which host is active alone", () => {
  const next = changedPreferences(
    {
      hosts: [{ host: "github.com" }, { host: "git.example.com", forge: "gitlab", extra: true }],
      host: "github.com",
      remote: "origin",
    },
    {
      kind: "host",
      original: "git.example.com",
      forge: "gitlab",
      host: "GitLab.Example.com ",
      account: "ada@example.com",
    },
  );
  expect(next).toEqual({
    value: {
      hosts: [
        { host: "github.com", forge: "github" },
        { host: "gitlab.example.com", forge: "gitlab", extra: true, account: "ada@example.com" },
      ],
      host: "github.com",
      remote: "origin",
    },
  });
});

test("a public host can't be saved under another provider, nor a host twice", () => {
  const saved = { hosts: [{ host: "github.com" }], host: "github.com", remote: "origin" };
  expect(
    changedPreferences(saved, { kind: "host", forge: "github", host: "gitlab.com", account: "" }),
  ).toEqual({ problem: "gitlab.com is GitLab. Choose GitLab for it." });
  expect(
    changedPreferences(saved, { kind: "host", forge: "github", host: "github.com", account: "" }),
  ).toEqual({ problem: "github.com is already saved." });
});

test("hosts read under their provider, and the active GitLab host is browse-only with glab", async () => {
  const { ask } = await open({
    hosts: [
      { host: "github.com" },
      { host: "gitlab.com", forge: "gitlab" },
      { host: "git.example.com", forge: "gitea" },
    ],
    host: "gitlab.com",
    remote: "origin",
  });
  const answer = await ask({ type: "source-control.screen" });
  expect(answer.ok).toBe(true);
  expect(answer.screen.hosts).toEqual([
    {
      host: "github.com",
      forge: "github",
      name: "GitHub",
      account: null,
      active: false,
      support: "full",
    },
    {
      host: "gitlab.com",
      forge: "gitlab",
      name: "GitLab",
      account: null,
      active: true,
      support: "browse",
    },
    {
      host: "git.example.com",
      forge: "gitea",
      name: "Gitea",
      account: null,
      active: false,
      support: "pending",
    },
  ]);
  expect(answer.screen.status).toMatchObject({
    name: "GitLab",
    cli: { title: "GitLab CLI", value: "glab 2.90.0" },
    api: { title: "GitLab API", value: "Signed in as ada" },
  });
  expect(answer.screen.status.note).toContain("Code review");
});

test("choosing the active host and the remote from the phone keeps a self-hosted GitLab host GitLab", async () => {
  const { ask, saved } = await open({
    hosts: [{ host: "github.com" }, { host: "git.example.com", forge: "gitlab", account: "ada" }],
    host: "github.com",
    remote: "origin",
  });
  expect(
    await ask({ type: "source-control.write", change: { kind: "use", host: "git.example.com" } }),
  ).toEqual({ ok: true });
  expect(
    await ask({ type: "source-control.write", change: { kind: "remote", remote: "upstream" } }),
  ).toEqual({ ok: true });
  expect(await saved()).toEqual({
    hosts: [
      { host: "github.com", forge: "github" },
      { host: "git.example.com", forge: "gitlab", account: "ada" },
    ],
    host: "git.example.com",
    remote: "upstream",
  });
  const screen = (await ask({ type: "source-control.screen" })).screen;
  expect(screen.status.name).toBe("GitLab");
});
