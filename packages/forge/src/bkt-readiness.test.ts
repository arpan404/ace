import { expect, test } from "vitest";
import { SourceControlPreferences } from "@ace/protocol";
import { bktContext, bktIdentity, bktReadiness } from "./bkt-readiness.ts";
import type { CommandResult, CommandRunner } from "./command.ts";

const signal = new AbortController().signal;
const cloud = {
  key: "api.bitbucket.org",
  kind: "cloud",
  base_url: "https://api.bitbucket.org/2.0",
};
const dc = { key: "git.corp", kind: "dc", base_url: "https://git.corp" };

/** `bkt auth status --json` as bkt prints it (pkg/cmd/auth runStatus), and GET /2.0/user. */
function bkt(state: {
  hosts?: unknown[];
  contexts?: unknown[];
  user?: unknown;
  version?: CommandResult;
}): CommandRunner {
  return async (request) => {
    const args = request.args.join(" ");
    if (args === "--version")
      return (
        state.version ?? { code: 0, stdout: "bkt version 0.38.1 (2026-11-09)\n", truncated: false }
      );
    if (args === "auth status --json")
      return {
        code: 0,
        stdout: JSON.stringify({ hosts: state.hosts ?? [cloud], contexts: state.contexts ?? [] }),
        truncated: false,
      };
    if (request.args[1] === "/2.0/user" && request.args[5] === "work")
      return {
        code: 0,
        stdout: JSON.stringify(state.user ?? { username: "ada", nickname: "Ada", uuid: "{1}" }),
        truncated: false,
      };
    return { code: 1, stdout: "", truncated: false, http: { status: 401, headers: {} } };
  };
}
const preferences = (account?: string, host = "bitbucket.org") =>
  SourceControlPreferences.parse({
    hosts: [{ host, forge: "bitbucket", ...(account ? { account } : {}) }],
    host,
    remote: "origin",
  });

test("the pinned context is a Cloud one, the repository's workspace first, never bkt's active Data Center context", async () => {
  const contexts = [
    { name: "a-dc", host: "git.corp", active: true },
    { name: "b-other", host: "api.bitbucket.org", workspace: "other" },
    { name: "c-team", host: "api.bitbucket.org", workspace: "team" },
  ];
  const runner = bkt({ hosts: [cloud, dc], contexts });
  await expect(bktContext(runner, "team", signal)).resolves.toBe("c-team");
  await expect(bktContext(runner, "elsewhere", signal)).resolves.toBe("b-other");
});

test.each([
  [
    "no Cloud host signed in",
    { hosts: [dc], contexts: [{ name: "x", host: "api.bitbucket.org" }] },
  ],
  ["no context on the Cloud host", { contexts: [{ name: "x", host: "git.corp" }] }],
  [
    "a Cloud key pointing at another server",
    {
      hosts: [{ ...cloud, base_url: "https://evil.test/2.0" }],
      contexts: [{ name: "x", host: "api.bitbucket.org" }],
    },
  ],
  ["a context named like a flag", { contexts: [{ name: "--input", host: "api.bitbucket.org" }] }],
])("no context is pinned with %s", async (_name, state) => {
  await expect(bktContext(bkt(state), "team", signal)).rejects.toMatchObject({
    kind: "forbidden",
  });
});

test("an identity probe fails closed once the context ace pinned is no longer the one it would pick", async () => {
  const work = { name: "work", host: "api.bitbucket.org", workspace: "team" };
  await expect(bktIdentity(bkt({ contexts: [work] }), "work", "team", signal)).resolves.toBe("ada");
  const edited = bkt({
    contexts: [work, { name: "aaa", host: "api.bitbucket.org", workspace: "team" }],
  });
  await expect(bktIdentity(edited, "work", "team", signal)).rejects.toMatchObject({
    kind: "forbidden",
  });
});

test("an account without Bitbucket's unique username is never named by nickname alone", async () => {
  const runner = bkt({
    contexts: [{ name: "work", host: "api.bitbucket.org" }],
    user: { nickname: "Ada", uuid: "{1}" },
  });
  await expect(bktIdentity(runner, "work", undefined, signal)).rejects.toMatchObject({
    kind: "invalid_data",
  });
});

test("readiness reports the verified account, and a different saved account as a mismatch", async () => {
  const runner = bkt({ contexts: [{ name: "work", host: "api.bitbucket.org" }] });
  const ready = await bktReadiness(runner, preferences(), signal);
  expect(ready).toMatchObject({
    cli: "available",
    version: "0.38.1",
    account: "ada",
    api: "ready",
  });
  const other = await bktReadiness(runner, preferences("grace"), signal);
  expect(other).toMatchObject({ account: "ada", api: "account_mismatch" });
});

test("readiness without a usable context asks the person to sign bkt in to Bitbucket Cloud", async () => {
  const status = await bktReadiness(bkt({ contexts: [] }), preferences(), signal);
  expect(status.api).toBe("login_required");
  expect(status.instructions).toContain("bkt auth login https://bitbucket.org --kind cloud --web");
});

test("readiness says bkt is missing when it can't run", async () => {
  const missing = bkt({ version: { code: 127, stdout: "", truncated: false } });
  expect(await bktReadiness(missing, preferences(), signal)).toMatchObject({
    cli: "unavailable",
    api: "unavailable",
  });
});

test("a Bitbucket Data Center host is never reported ready, even with a signed-in bkt", async () => {
  const runner = bkt({ contexts: [{ name: "work", host: "api.bitbucket.org" }] });
  const status = await bktReadiness(runner, preferences(undefined, "git.corp"), signal);
  expect(status).toMatchObject({ api: "unavailable", account: null });
  expect(status.instructions).toContain("Data Center isn't supported");
});
