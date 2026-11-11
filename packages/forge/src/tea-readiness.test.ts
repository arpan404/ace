import { expect, test } from "vitest";
import { SourceControlPreferences } from "@ace/protocol";
import { teaReadiness, teaLogin, teaIdentity } from "./tea-readiness.ts";
import type { CommandRunner } from "./command.ts";
const signal = new AbortController().signal;
const preferences = SourceControlPreferences.parse({
  hosts: [{ forge: "gitea", host: "git.example", account: "alice" }],
  host: "git.example",
  remote: "origin",
});
const login = { name: "office", url: "https://git.example/", user: "alice", default: "true" };
function runner(entries: unknown, account = "alice", status = 200): CommandRunner {
  return async (request) => {
    if (request.command !== "tea") throw new Error("wrong CLI");
    if (request.args[0] === "--version")
      return { code: 0, stdout: "tea version 0.15.0", truncated: false };
    if (request.args.join(" ") === "login list --output json")
      return { code: 0, stdout: JSON.stringify(entries), truncated: false };
    if (request.args.join(" ") !== "api user --method GET --login office --include")
      throw new Error("unsafe command");
    return {
      code: 0,
      stdout: JSON.stringify({ login: account }),
      truncated: false,
      http: { status, headers: {} },
    };
  };
}
test("readiness proves the live API user on the host's named login", async () => {
  expect(await teaReadiness(runner([login]), preferences, signal)).toMatchObject({
    cli: "available",
    api: "ready",
    account: "alice",
  });
  expect(await teaReadiness(runner([login], "bob"), preferences, signal)).toMatchObject({
    api: "account_mismatch",
    account: "bob",
  });
});
test.each([
  [login, { ...login, name: "duplicate" }],
  [{ ...login, url: "http://git.example" }],
  [{ ...login, url: "https://alice:secret@git.example/" }],
  [{ ...login, url: "https://git.example/subpath" }],
  [],
])("login selection fails closed instead of choosing a default", async (...entries) => {
  await expect(teaLogin(runner(entries), "git.example", signal)).rejects.toMatchObject({
    kind: "forbidden",
  });
});
test("a renamed login or a failed API answer cannot prove identity", async () => {
  await expect(
    teaIdentity(runner([{ ...login, name: "renamed" }]), "git.example", "office", signal),
  ).rejects.toMatchObject({ kind: "forbidden" });
  expect((await teaReadiness(runner([login], "alice", 429), preferences, signal)).api).toBe(
    "rate_limited",
  );
  expect((await teaReadiness(runner([login], "alice", 401), preferences, signal)).api).toBe(
    "login_required",
  );
  expect((await teaReadiness(runner([login], "alice", 503), preferences, signal)).api).toBe(
    "unavailable",
  );
});
