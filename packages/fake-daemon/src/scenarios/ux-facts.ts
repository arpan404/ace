import type { Fact } from "@ace/core";
import type { MessageOrigin, ProviderKind } from "@ace/protocol";
import type { Scenario, Step } from "../scenario.ts";
import { checkout } from "./checkouts.ts";
import { endTurn, output, rootAgent, tool, turn } from "./facts.ts";
export const cwd = "/Users/dev/.ace-next/worktrees/ace/fix-login";
const root = "root";
export function input(item: string, text: string, origin: MessageOrigin): Fact {
  return {
    type: "item.upsert",
    agent: root,
    item,
    draft: {
      type: "message",
      role: "user",
      complete: true,
      synthetic: origin.kind !== "person",
      origin,
      parts: [{ type: "text", text }],
    },
  };
}
export function scenario(
  name: string,
  title: string,
  facts: Fact[],
  options: {
    provider?: ProviderKind;
    initialInput?: Fact;
    after?: Step[];
    pending?: boolean;
  } = {},
): Scenario {
  const provider = options.provider ?? "codex";
  return {
    thread: {
      id: `thread-ux-${name}`,
      workspaceId: "relay",
      title,
      provider,
      details: checkout({
        workspaceId: "relay",
        branch: "ace/fix-login",
        path: cwd,
        head: "a1b2c3",
      }),
    },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent(provider, cwd),
          turn(root),
          options.initialInput ?? input("request", title, { kind: "person" }),
          ...facts,
          ...(options.pending || options.after ? [] : [endTurn(root)]),
        ],
      },
      ...(options.after ?? []),
    ],
  };
}
export function command(
  key: string,
  inner: string,
  status: "succeeded" | "failed" = "succeeded",
): Fact[] {
  return [
    tool(root, key, {
      kind: "shell",
      title: `Run ${inner}`,
      detail: { kind: "shell", command: inner, rawCommand: `/bin/zsh -lc '${inner}'` },
    }),
    output(root, key, status === "failed" ? "FAIL src/login.test.ts\n1 test failed\n" : "Done\n"),
    {
      type: "item.upsert",
      agent: root,
      item: key,
      draft: {
        type: "tool_call",
        complete: true,
        call: { status, detail: { kind: "shell", exitCode: status === "failed" ? 1 : 0 } },
      },
    },
  ];
}
