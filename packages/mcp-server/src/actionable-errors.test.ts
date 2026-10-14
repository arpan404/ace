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

it("agent-control failures carry the next step, and results have a real data schema", async () => {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  agentControlToolkit({
    async execute(_caller, operation) {
      return operation.op === "agent.result"
        ? {
            ok: false,
            code: "not_ready",
            data: { threadId: "child", state: "working", generation: 0 },
          }
        : { ok: false, code: "forbidden" };
    },
  }).register(registry);
  const principal = lease().principal;
  const notReady = await registry.call(
    "ace_agent_result",
    { threadId: "child" },
    principal,
    new AbortController().signal,
  );
  expect(notReady.structuredContent).toMatchObject({
    ok: false,
    code: "not_ready",
    hint: expect.stringContaining("ace_wait"),
  });
  const tools = registry.list(principal);
  const result = tools.find((tool) => tool.name === "ace_agent_result");
  expect(JSON.stringify(result?.outputSchema)).toContain("waiting_on_human");
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
  await registry.call("ace_thread_read", {}, principal, new AbortController().signal);
  expect(seen).toEqual([expect.objectContaining({ op: "thread.read", threadId: "thread" })]);
  for (const tool of registry.list(principal))
    expect(tool.annotations?.readOnlyHint).toBe(tool["_meta"]?.["ace/riskClass"] === "read-only");
  // ace_status lives outside the control catalogue but still attributes as a read.
  expect(aceToolAction("mcp__ace__ace_status", {})).toMatchObject({ riskClass: "read-only" });
});
