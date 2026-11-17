import { describe, expect, test } from "vitest";
import { commandTable } from "./commands/table.ts";
import { parseCommandLine } from "./parse.ts";

const table = commandTable();
const parse = (line: string) => parseCommandLine(table, line ? line.split(" ") : []);

describe("each command line reaches its command with its arguments and flags", () => {
  test.each([
    ["", "home", [], {}],
    ["thread list", "thread.list", [], {}],
    ["thread", "thread.list", [], {}],
    ["threads", "thread.list", [], {}],
    ["thread show t_9f2c41", "thread.show", ["t_9f2c41"], {}],
    ["run fix-it --provider claude", "thread.start", ["fix-it"], { provider: "claude" }],
    ["thread start - --worktree --follow", "thread.start", ["-"], { worktree: true, follow: true }],
    ["chat", "thread.attach", [], {}],
    ["--json thread list", "thread.list", [], { json: true }],
    ["thread list -q", "thread.list", [], { quiet: true }],
    ["thread wait a b c --any", "thread.wait", ["a", "b", "c"], { any: true }],
    ["thread send t1 -- --not-a-flag", "thread.send", ["t1", "--not-a-flag"], {}],
    ["project add .", "project.add", ["."], {}],
    ["open", "project.open", [], {}],
    ["start --json", "daemon.start", [], { json: true }],
    ["serve --json", "daemon.serve", [], { json: true }],
    ["stop", "daemon.stop", [], {}],
    ["status --json", "status", [], { json: true }],
    ["logs -f", "daemon.logs", [], { follow: true }],
    ["storage", "storage.usage", [], {}],
    ["doctor --json", "doctor", [], { json: true }],
    ["doctor bundle /tmp/b", "doctor.bundle", ["/tmp/b"], {}],
    ["config set retention-days 30", "config.set", ["retention-days", "30"], {}],
    ["login", "account.login", [], {}],
    ["provider account list", "provider.account.list", [], {}],
    ["help thread send", "help", ["thread", "send"], {}],
    ["thread list -qy", "thread.list", [], { quiet: true, yes: true }],
    ["thread list --timeout=30s", "thread.list", [], { timeout: "30s" }],
    ["version", "version", [], {}],
    ["supervise --anything goes", "release.supervise", ["--anything", "goes"], {}],
  ])("ace %s", (line, id, words, flags) => {
    const parsed = parse(line);
    expect(parsed.kind).toBe("command");
    if (parsed.kind !== "command") return;
    expect(parsed.command.id).toBe(id);
    expect(parsed.words).toEqual(words);
    expect({ ...parsed.flags }).toEqual(flags);
  });
});

describe("old spellings reach the new command, marked as old", () => {
  test.each([
    ["threads list", "thread.list", [], {}],
    ["thread read t1", "thread.show", ["t1"], {}],
    ["thread cancel t1", "thread.stop", ["t1"], {}],
    ["thread interrupt t1", "thread.stop", ["t1"], {}],
    ["task spawn hi --parent t1", "thread.start", ["hi"], { parent: "t1" }],
    ["task wait t1 t2", "thread.wait", ["t1", "t2"], { tree: true }],
    ["task status t1", "thread.status", ["t1"], {}],
    ["kill-all --provider codex", "thread.stop", [], { provider: "codex", all: true }],
    ["thread approve t1 --interaction i1", "request.allow", [], { thread: "t1", request: "i1" }],
    ["add .", "project.add", ["."], {}],
    ["clean --logs", "storage.clean", [], { logs: true }],
    ["clean --compact", "storage.compact", [], { compact: true }],
    ["clean apply p1 --revision r", "storage.apply", ["p1"], { revision: "r" }],
    ["support-bundle /tmp/b", "doctor.bundle", ["/tmp/b"], {}],
    ["token", "daemon.token", [], {}],
    ["providers status", "provider.list", [], {}],
    ["capabilities", "provider.capabilities", [], {}],
    ["login codex", "provider.login", ["codex"], {}],
    ["machine-code clear", "account.machine-code.clear", [], {}],
    ["accounts status a1", "provider.account.show", ["a1"], {}],
    ["devices revoke d1", "device.revoke", ["d1"], {}],
    ["pair --ttl 1h", "device.pair", [], { ttl: "1h" }],
    ["pair redeem URL --profile work", "remote.add", [], { link: "URL", profile: "work" }],
    ["mcp enroll --scope read --ttl 1h", "mcp.add", [], { scope: "read", ttl: "1h" }],
    ["features on spade", "feature.on", ["spade"], {}],
    ["browser shot t1", "browser.screenshot", ["t1"], {}],
    ["marketplace check . --type suit", "market.check", ["."], { type: "suit" }],
    ["market keygen key.json", "market.maintainer.keygen", ["key.json"], {}],
  ])("ace %s", (line, id, words, flags) => {
    const parsed = parse(line);
    expect(parsed.kind).toBe("command");
    if (parsed.kind !== "command") return;
    expect(parsed.command.id).toBe(id);
    expect(parsed.alias?.deprecatedSince).toBeTruthy();
    expect(parsed.words).toEqual(words);
    expect({ ...parsed.flags }).toEqual(flags);
  });

  test("shortcuts are permanent, not old spellings", () => {
    for (const line of ["run x", "chat", "open", "start", "serve", "stop", "logs", "login"]) {
      const parsed = parse(line);
      expect(parsed.kind === "command" && parsed.alias?.deprecatedSince).toBeFalsy();
    }
  });
});

describe("a wrong command line is a usage error naming what's wrong and the nearest fix", () => {
  test.each([
    ["thraed list", "unknown_command", "ace thread"],
    ["thread lsit", "unknown_command", "ace thread list"],
    ["prjoect", "unknown_command", "ace project"],
    ["thread list --jsno", "unknown_flag", "--json"],
    ["thread list --projcet x", "unknown_flag", "--project"],
  ])("ace %s", (line, code, suggestion) => {
    const parsed = parse(line);
    expect(parsed).toMatchObject({ kind: "usage", code, suggestion });
  });

  test.each([
    ["zzzz", "unknown_command"],
    ["thread show a b", "too_many_arguments"],
    ["thread list --project", "missing_argument"],
    ["thread list --worktree=yes", "unknown_flag"],
    ["thread start --worktree=yes", "bad_argument"],
    ["thread list --color sometimes", "bad_argument"],
    ["thread list --json --json", "bad_argument"],
  ])("ace %s", (line, code) => {
    expect(parse(line)).toMatchObject({ kind: "usage", code });
  });

  test("nothing close enough suggests ace help instead of a wild guess", () => {
    const parsed = parse("xylophone");
    expect(parsed).toMatchObject({ kind: "usage", hint: "See every command with ace help." });
    expect(parsed.kind === "usage" && parsed.suggestion).toBeFalsy();
  });
});

test("a required argument left out is reported as missing, so a terminal can ask for it", () => {
  const parsed = parse("thread status");
  expect(parsed.kind === "command" && parsed.missing.map((arg) => arg.name)).toEqual(["THREAD"]);
  const given = parse("thread status t1");
  expect(given.kind === "command" && given.missing).toEqual([]);
});

test("a noun without a default of its own answers with its page, not an error", () => {
  expect(parse("market")).toMatchObject({ kind: "noun", words: ["market"] });
  expect(parse("provider account")).toMatchObject({
    kind: "noun",
    words: ["provider", "account"],
  });
});

test("no two commands or aliases claim the same words", () => {
  const seen = new Map<string, string>();
  for (const command of table.commands)
    for (const words of [command.words, ...(command.aliases ?? []).map((alias) => alias.words)]) {
      const key = words.join(" ");
      expect(seen.get(key), key).toBeUndefined();
      seen.set(key, command.id);
    }
});
