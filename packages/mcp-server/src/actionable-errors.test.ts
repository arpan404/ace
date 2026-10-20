import { expect, it } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry, aceToolAction, agentControlToolkit } from "./index.ts";
import { scope } from "./test-support.ts";

const lease = () =>
  new CredentialRegistry(() => "a".repeat(64)).issue(
    scope("root", ["agents", "thread_control"]),
    new AbortController().signal,
  );
const errorPayload = (result: { content: unknown[] }) =>
  z
    .object({
      code: z.string(),
      hint: z.string(),
      issues: z.array(z.object({ path: z.string(), expected: z.string() })).optional(),
      detail: z.string().optional(),
    })
    .parse(JSON.parse(z.object({ text: z.string() }).parse(result.content[0]).text));

it("a wrong argument names each field and what it expects, without echoing the value", async () => {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  let effects = 0;
  registry.register({
    name: "ace_example",
    description: "Example",
    capability: null,
    timeoutMs: 1000,
    input: z.strictObject({
      title: z.string().min(1),
      mode: z.enum(["static", "interactive"]),
      limit: z.number().int().max(20).default(10),
    }),
    output: z.object({}),
    async run() {
      effects++;
      return {};
    },
  });
  const principal = lease().principal;
  const result = await registry.call(
    "ace_example",
    { titel: "secret-title-value", mode: "fancy", limit: 500 },
    principal,
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(effects).toBe(0);
  const payload = errorPayload(result);
  expect(payload.code).toBe("invalid_arguments");
  expect(payload.hint).not.toMatch(/browser/i);
  expect(payload.issues).toEqual(
    expect.arrayContaining([
      { path: "title", expected: "required string, missing" },
      { path: "mode", expected: 'one of "static", "interactive"' },
      { path: "limit", expected: "number <= 20" },
      expect.objectContaining({ path: "titel" }),
    ]),
  );
  expect(JSON.stringify(result)).not.toContain("secret-title-value");
  expect(JSON.stringify(result)).not.toContain("fancy");
  // The model can repair from the paths alone.
  const repaired = await registry.call(
    "ace_example",
    { title: "x", mode: "static", limit: 10 },
    principal,
    new AbortController().signal,
  );
  expect(repaired.isError).toBeUndefined();
});

it("an agent-control failure names the agent's own next call, not the person", async () => {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  agentControlToolkit({
    async execute(_caller, operation) {
      return operation.op === "agent.status"
        ? { ok: false, code: "not_ready", data: { threadId: "child", state: "working" } }
        : { ok: false, code: "forbidden" };
    },
  }).register(registry);
  const principal = lease().principal;
  const notReady = await registry.call(
    "agents_status",
    { threadId: "child" },
    principal,
    new AbortController().signal,
  );
  expect(notReady.structuredContent).toMatchObject({
    ok: false,
    code: "not_ready",
    hint: expect.stringContaining("Call wait"),
  });
  // The client shows the refusal as a failed call, so a transcript never records it as done.
  expect(notReady.isError).toBe(true);
  const forbidden = await registry.call(
    "thread_control",
    { action: "settle", threadId: "other" },
    principal,
    new AbortController().signal,
  );
  expect(forbidden.structuredContent).toMatchObject({
    code: "forbidden",
    hint: expect.stringContaining("threads_find"),
  });
});

it("a wrongly shaped call lists the fields and variants the schema has, never the values sent", async () => {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  agentControlToolkit({ execute: async () => ({ ok: true, data: { threadIds: [] } }) }).register(
    registry,
  );
  const principal = lease().principal;
  const wrongField = errorPayload(
    await registry.call(
      "thread_link_pr",
      { pr: "secret-pr-value" },
      principal,
      new AbortController().signal,
    ),
  );
  expect(wrongField.issues).toContainEqual({
    path: "pr",
    expected: "no such field; fields here: url, number, repo, unlink, all",
  });
  const wrongVariant = await registry.call(
    "delegate",
    {
      tasks: [
        {
          requestId: "a",
          task: "Do it",
          role: "do-it-now",
          workspace: { kind: "secret-kind-value" },
        },
      ],
    },
    principal,
    new AbortController().signal,
  );
  const payload = z
    .object({
      detail: z.string(),
      issues: z.array(z.object({ path: z.string(), expected: z.string() })),
    })
    .parse(errorPayload(wrongVariant));
  expect(payload.issues).toContainEqual({
    path: "tasks[0].workspace.kind",
    expected: 'one of "project", "new_worktree", "existing_worktree"',
  });
  expect(payload.detail).toBe("tools_find delegate returns its schema.");
  expect(JSON.stringify([wrongField, wrongVariant])).not.toMatch(/secret-/);
});

it("an action's missing field is named before anything reaches the daemon", async () => {
  const sent: unknown[] = [];
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  agentControlToolkit({
    async execute(_caller, operation) {
      sent.push(operation);
      return { ok: true };
    },
  }).register(registry);
  const result = await registry.call(
    "thread_control",
    { action: "handoff", threadId: "child", requestId: "move" },
    lease().principal,
    new AbortController().signal,
  );
  expect(errorPayload(result).issues).toEqual([expect.objectContaining({ path: "branch" })]);
  expect(sent).toEqual([]);
});

it("reading your own thread needs no id, and every read is annotated read-only", async () => {
  const seen: unknown[] = [];
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  agentControlToolkit({
    async execute(_caller, operation) {
      seen.push(operation);
      return { ok: true, data: {} };
    },
  }).register(registry);
  const principal = lease().principal;
  await registry.call("thread_read", {}, principal, new AbortController().signal);
  expect(seen).toContainEqual(expect.objectContaining({ op: "thread.read", threadId: "thread" }));
  for (const tool of registry.list(principal))
    expect(tool.annotations?.readOnlyHint).toBe(tool["_meta"]?.["ace/riskClass"] === "read-only");
  // context lives outside the control catalogue but still attributes as a read, in any spelling.
  expect(aceToolAction("mcp__ace__context", {})).toMatchObject({ riskClass: "read-only" });
  expect(aceToolAction("ace_context", {})).toMatchObject({ tool: "context" });
});
