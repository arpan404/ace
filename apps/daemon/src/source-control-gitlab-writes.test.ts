import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { ForgeRepository } from "@ace/protocol";
import type { CommandRequest, CommandRunner } from "@ace/forge";
import { SourceControl } from "./source-control.ts";

const repository = ForgeRepository.parse({
  forge: "gitlab",
  host: "gitlab.com",
  owner: "team",
  name: "repo",
});
const writes = [
  { method: "POST" as const, endpoint: /^projects\/team%2Frepo\/pipelines\/7\/retry$/ },
];
const signal = new AbortController().signal;
const request: CommandRequest = {
  command: "glab",
  args: [
    "api",
    "projects/team%2Frepo/pipelines/7/retry",
    "-X",
    "POST",
    "--hostname",
    "gitlab.com",
    "--include",
    "--input",
    "-",
  ],
  input: "{}",
  signal,
  mode: "json",
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ace-glab-writes-"));
  const settings = new SettingsService({ dataDir: root });
  await settings.set(
    "sourceControl.preferences",
    {
      hosts: [{ host: "gitlab.com", forge: "gitlab", account: "alice" }],
      host: "gitlab.com",
      remote: "origin",
    },
    { kind: "global" },
  );
  let account = "alice";
  let switchDuringWrite = false;
  const effects: CommandRequest[] = [];
  const runner: CommandRunner = async (input) => {
    if (input.args[1] === "user")
      return {
        code: 0,
        truncated: false,
        stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify({ username: account })}`,
      };
    effects.push(input);
    input.dispatch?.prepare?.();
    input.dispatch?.record();
    if (switchDuringWrite) account = "bob";
    return { code: 0, truncated: false, stdout: "HTTP/2.0 200 OK\n\n{}" };
  };
  const source = new SourceControl(
    settings,
    () => runner,
    root,
    () => 1,
  );
  return {
    source,
    effects,
    switchBefore: () => {
      account = "bob";
    },
    switchDuring: () => {
      switchDuringWrite = true;
    },
    close: async () => {
      source.close();
      await settings.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("GitLab write identity dispatches the exact admitted request and refuses every altered shape", async () => {
  const f = await fixture();
  try {
    const { runner } = await f.source.writeIdentity(".", repository, writes, signal);
    await runner(request);
    expect(f.effects).toEqual([request]);
    const refused = [
      { ...request, command: "gh" },
      { ...request, args: [...request.args, "--paginate"] },
      { ...request, args: request.args.map((arg) => (arg === "POST" ? "DELETE" : arg)) },
      {
        ...request,
        args: request.args.map((arg) => (arg === "gitlab.com" ? "other.example" : arg)),
      },
      {
        ...request,
        args: request.args.map((arg) =>
          arg.endsWith("/retry") ? "projects/team%2Frepo/pipelines/7/cancel" : arg,
        ),
      },
      { ...request, input: "[]" },
      { ...request, input: "null" },
      { ...request, input: "not-json" },
    ];
    for (const altered of refused)
      await expect(runner(altered)).rejects.toMatchObject({ kind: "unsupported" });
    expect(f.effects).toEqual([request]);
  } finally {
    await f.close();
  }
});

test("an account switch before a GitLab write refuses dispatch", async () => {
  const f = await fixture();
  try {
    const { runner } = await f.source.writeIdentity(".", repository, writes, signal);
    f.switchBefore();
    await expect(runner(request)).rejects.toMatchObject({ kind: "forbidden" });
    expect(f.effects).toEqual([]);
  } finally {
    await f.close();
  }
});

test("an account switch during a GitLab write marks its result uncertain", async () => {
  const f = await fixture();
  try {
    const { runner } = await f.source.writeIdentity(".", repository, writes, signal);
    f.switchDuring();
    expect(await runner(request)).toMatchObject({ identityChanged: true });
    expect(f.effects).toEqual([request]);
  } finally {
    await f.close();
  }
});
