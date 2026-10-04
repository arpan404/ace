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
    expect(item?.type === "tool_call" && item.call.raw[0]?.data).toMatchObject({
      commandActions: actions,
    });
  },
);
test("several read actions retain their paths and classify by the first action", () => {
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
      kind: "file.read",
      title: "Run cat a && rg x",
      detail: { path: "/repo/a" },
      raw: [{ data: { commandActions: actions } }],
    },
  });
});
