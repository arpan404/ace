import { expect, test } from "vitest";
import { setup } from "./translator.test-helper.ts";

test.each([
  {
    command: "/bin/zsh -lc 'bun install --frozen-lockfile'",
    actions: [],
    readable: "bun install --frozen-lockfile",
  },
  {
    command: "/bin/zsh -lc 'provider wrapper'",
    actions: [{ type: "unknown", command: "pwd" }],
    readable: "pwd",
  },
  {
    command: "/bin/sh -c 'pwd && echo ok'",
    actions: [
      { type: "unknown", command: "pwd" },
      { type: "unknown", command: "echo ok" },
    ],
    readable: "pwd && echo ok",
  },
])(
  "shell details show $readable and retain the exact wrapper",
  ({ command, actions, readable }) => {
    const h = setup();
    h.start();
    h.item(
      {
        id: "command",
        type: "commandExecution",
        command,
        commandActions: actions,
        cwd: "/repo",
        status: "completed",
        exitCode: 0,
      },
      true,
    );
    const item = h.state.items["command"];
    expect(item).toMatchObject({
      type: "tool_call",
      call: {
        title: `Run ${readable}`,
        detail: { kind: "shell", command: readable, rawCommand: command, exitCode: 0 },
      },
    });
    expect(item?.type === "tool_call" ? item.call.raw[0] : undefined).toMatchObject({
      data: { commandActions: actions },
    });
  },
);
test("every read and search action has structured detail and the aggregate retains raw command", () => {
  const h = setup();
  const actions = [
    { type: "read", path: "/repo/a", command: "cat a" },
    { type: "search", path: "/repo", command: "rg x", query: "x" },
  ];
  h.item(
    {
      id: "read",
      type: "commandExecution",
      command: "/bin/sh -c 'cat a && rg x'",
      commandActions: actions,
    },
    true,
  );
  expect(h.state.items["read"]).toMatchObject({
    call: {
      kind: "shell",
      title: "Run cat a && rg x",
      detail: { command: "cat a && rg x", rawCommand: "/bin/sh -c 'cat a && rg x'" },
      raw: [{ data: { commandActions: actions } }],
    },
  });
});

test("all read/search paths survive started and completed command updates", () => {
  const h = setup();
  h.start();
  const item = {
    id: "many",
    type: "commandExecution",
    command: "/bin/sh -c 'cat a && cat b && rg x src'",
    commandActions: [
      { type: "read", path: "a", command: "cat a" },
      { type: "read", path: "b", command: "cat b" },
      { type: "search", path: "src", query: "x", command: "rg x src" },
    ],
  };
  h.item(item);
  h.item(item, true);
  expect(h.state.items["many:action:0"]).toMatchObject({
    complete: true,
    call: { detail: { kind: "file.read", path: "a" } },
  });
  expect(h.state.items["many:action:1"]).toMatchObject({
    complete: true,
    call: { detail: { kind: "file.read", path: "b" } },
  });
  expect(h.state.items["many:action:2"]).toMatchObject({
    complete: true,
    call: { detail: { kind: "search", path: "src", query: "x" } },
  });
});

test("missing action command text never duplicates a large executable script", () => {
  const h = setup();
  const script = "echo " + "x".repeat(10000);
  h.item(
    {
      id: "large",
      type: "commandExecution",
      command: `/bin/sh -c '${script}'`,
      commandActions: Array.from({ length: 1000 }, (_, index) => ({
        type: "read",
        path: `file-${index}`,
      })),
    },
    true,
  );
  expect(h.state.items["large"]).toMatchObject({
    call: { detail: { kind: "shell", command: script } },
  });
  expect(h.state.items["large:action:999"]).toMatchObject({
    call: { detail: { kind: "file.read", path: "file-999" } },
  });
});
