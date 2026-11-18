import { describe, expect, test } from "vitest";
import { z } from "zod";
import { CliTree, Interaction, Project, ThreadListEntry } from "@ace/protocol";
import { cliOutputs } from "@ace/protocol/cli-outputs";
import { workCommands } from "../commands/work.ts";
import { pageRows, threadListJson, threadRows } from "./rows.ts";
import { statusJson } from "./status.ts";

/**
 * Golden `--json` values, built by the code the commands print with, checked against the
 * schemas `ace help COMMAND --schema` publishes (ADR 0178 §3).
 */
const now = 1_800_000_000_000;

const entries = [
  ThreadListEntry.parse({
    id: "t_parent1",
    workspaceId: "w_ace",
    title: "Fix the upload test",
    provider: "codex",
    status: { state: "done" },
    live: { runningSubagentCount: 1, workingSince: now - 60_000 },
    createdAt: now - 3_600_000,
    updatedAt: now - 60_000,
    hasSentMessage: true,
  }),
  ThreadListEntry.parse({
    id: "t_asking1",
    workspaceId: "w_ace",
    title: "Upgrade Bun",
    provider: "claude",
    status: { state: "needs_you", interactions: 1 },
    live: { asking: [{ id: "i_asking1", kind: "approval" }] },
    createdAt: now - 3_600_000,
    updatedAt: now - 120_000,
    hasSentMessage: true,
  }),
];

const schema = (key: string) => {
  const found = Object.entries(cliOutputs).find(([name]) => name === key)?.[1];
  if (!found) throw new Error(`no schema ${key}`);
  return found;
};

describe("work commands' --json output", () => {
  test("thread list carries each thread in the app's order with its state in words", () => {
    const rows = threadRows({
      entries,
      projectNames: new Map([["w_ace", "ace"]]),
      now,
      baseline: now - 86_400_000,
    });
    const value = threadListJson(entries, pageRows(rows.rows, 1, undefined), undefined);
    const parsed = z.object({
      rows: z.array(z.object({ state: z.string(), meaning: z.string() })),
    });
    expect(schema("thread.list").safeParse(value).success).toBe(true);
    expect(parsed.parse(value).rows).toEqual([
      expect.objectContaining({ state: "needs-you", meaning: "Needs approval" }),
    ]);
    expect(value.next).toBe("t_asking1");
    const json = JSON.stringify(value);
    expect(json).not.toContain('"icon"');
    expect(json).not.toContain("\u001b[");
  });

  test("ace status keeps the daemon's health exactly and adds its extras", () => {
    const health = { running: true, version: "development", ready: true, remote: { origin: "x" } };
    const value = statusJson(
      health,
      { signedIn: true, email: "person@example.com" },
      {
        needsYou: 2,
        working: 1,
      },
    );
    expect(schema("status").safeParse(value).success).toBe(true);
    expect(value).toMatchObject(health);
    expect(statusJson(health, undefined, undefined)).toEqual(health);
    expect(schema("status").safeParse({ running: false }).success).toBe(true);
  });

  test("request list, request show, thread tree and project show match their schemas", () => {
    const interaction = Interaction.parse({
      id: "i_asking1",
      threadId: "t_asking1",
      agentId: "root",
      blocking: true,
      state: "pending",
      createdAt: now,
      request: { kind: "approval", title: "Run bun test", options: [] },
    });
    const open = {
      threadId: "t_asking1",
      threadTitle: "Upgrade Bun",
      workspaceId: "w_ace",
      provider: "claude",
      interaction,
    };
    expect(schema("request.list").safeParse({ requests: [open], truncated: false }).success).toBe(
      true,
    );
    expect(schema("request.show").safeParse(open).success).toBe(true);
    const tree = CliTree.parse([
      {
        threadId: "t_parent1",
        status: { state: "done" },
        pending: false,
        queue: { revision: 1, paused: false, reason: null, resumeAt: null, uncertain: false },
        cancelled: false,
        title: "Fix the upload test",
      },
    ]);
    expect(schema("thread.tree").safeParse(tree).success).toBe(true);
    const project = Project.parse({ id: "w_ace", name: "ace", path: "/work/ace" });
    expect(
      schema("project.show").safeParse({
        project,
        threads: { total: 2, needsYou: 1, running: 1 },
      }).success,
    ).toBe(true);
  });

  test("every work command's schema prints as JSON Schema for ace help --schema", () => {
    const keys = [
      ...new Set(workCommands.flatMap((command) => (command.output ? [command.output] : []))),
    ];
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) expect(() => z.toJSONSchema(schema(key)), key).not.toThrow();
  });
});
