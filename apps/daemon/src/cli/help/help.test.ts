import { CliCommandTree, CliError } from "@ace/protocol/cli-output";
import { expect, test } from "vitest";
import { commandTable } from "../commands/table.ts";
import { toCliError } from "../errors.ts";
import { handlers } from "../run/index.ts";
import { commandJson, commandTree, helpFor } from "./index.ts";

const table = commandTable();
const visible = table.commands.filter((command) => !command.hidden);

test("the overview names every noun and fits on one screen", () => {
  const { text } = helpFor(table, []);
  for (const noun of table.nouns) expect(text).toContain(noun.name);
  expect(text.split("\n").length).toBeLessThanOrEqual(25);
  // Maintainer tools are never in the overview.
  expect(text).not.toContain("maintainer");
});

test.each(visible.map((command) => [command.id, command] as const))(
  "ace help %s prints its usage, what it does and how to read more",
  (_id, command) => {
    const { text } = helpFor(table, command.words);
    expect(text).toContain(`ace ${command.words.join(" ")}`);
    expect(text).toContain(command.summary);
    for (const arg of command.args ?? []) expect(text).toContain(arg.name);
    for (const flag of (command.flags ?? []).filter((item) => !item.hidden))
      expect(text).toContain(`--${flag.name}`);
  },
);

test("a noun's page lists each of its commands with one line", () => {
  const { text } = helpFor(table, ["thread"]);
  for (const command of visible.filter((item) => item.words[0] === "thread"))
    expect(text).toContain(command.summary);
  expect(text).toContain("ace run is ace thread start");
});

test("help for a shortcut is the command it stands for", () => {
  expect(helpFor(table, ["run"]).command?.id).toBe("thread.start");
  expect(helpFor(table, ["threads", "list"]).command?.id).toBe("thread.list");
});

test("topics print their own page", () => {
  for (const topic of ["output", "exit-codes", "agents", "scripting", "remote", "publishing"])
    expect(helpFor(table, [topic]).text.length).toBeGreaterThan(40);
  expect(helpFor(table, ["exit-codes"]).text).toContain("64");
});

test("help for something that doesn't exist is a usage error with the nearest name", () => {
  const error = toCliError(captured(() => helpFor(table, ["thraed"])));
  expect(error).toMatchObject({ status: "usage", code: "unknown_command" });
  expect(error.hint).toContain("ace help thread");
});

test("help --json is a CliCommandTree with every visible command and no hidden one", () => {
  const tree = CliCommandTree.parse(commandTree(table, "0.0.24"));
  expect(tree.commands.map((command) => command.id).toSorted()).toEqual(
    visible.map((command) => command.id).toSorted(),
  );
  expect(tree.commands.some((command) => command.id.startsWith("market.maintainer"))).toBe(false);
  expect(tree.exitCodes.find((exit) => exit.code === 64)?.name).toBe("usage");
  // Hidden flags (old spellings) are accepted but never advertised.
  const show = tree.commands.find((command) => command.id === "request.allow");
  expect(show?.flags.map((flag) => flag.name)).not.toContain("request");
});

test("every command help --json describes has a handler that runs it", () => {
  for (const command of table.commands) expect(handlers[command.id], command.id).toBeDefined();
  expect(commandJson(table.byId.get("thread.start") ?? visible[0]!).aliases).toContainEqual({
    words: ["run"],
  });
});

test("a failure's JSON is a CliError", () => {
  const error = toCliError(
    captured(() => helpFor(table, ["nope"])),
    "help",
  );
  expect(CliError.parse(error)).toMatchObject({ ok: false, command: "help" });
});

function captured(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}
