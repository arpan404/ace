import { expect, it } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry, agentControlToolkit } from "./index.ts";
import { scope } from "./test-support.ts";

const lease = () =>
  new CredentialRegistry(() => "a".repeat(64)).issue(
    scope("root", ["agents", "thread_control"]),
    new AbortController().signal,
  );
const Workspace = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("project") }),
  z.strictObject({ kind: z.literal("new_worktree"), base: z.strictObject({ ref: z.string() }) }),
  z.strictObject({ kind: z.literal("existing_worktree"), path: z.string().min(1).max(4096) }),
]);

function example() {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  const runs: unknown[] = [];
  registry.register({
    name: "ace_example",
    description: "Example",
    capability: null,
    timeoutMs: 1000,
    input: z
      .strictObject({
        workspace: Workspace.optional().describe("Where it runs."),
        access: z.union([z.literal("inherit"), z.enum(["read-only", "full-access"])]).optional(),
        query: z.string().default(""),
      })
      .refine((input) => input.query !== "secret", { message: "query must not be secret." })
      .meta({ "x-ace-constraint": "query must not be secret." }),
    output: z.strictObject({ count: z.number().int() }),
    async run(input) {
      runs.push(input);
      return { count: 1 };
    },
  });
  return { registry, runs };
}

it("models read a flat schema: one workspace object, one access enum, no internal notes", () => {
  const { registry } = example();
  const [tool] = registry.list(lease().principal);
  const text = JSON.stringify(tool?.inputSchema);
  expect(text).not.toMatch(/oneOf|anyOf|x-ace-constraint|additionalProperties|maxLength|\$schema/);
  expect(tool?.inputSchema.properties).toMatchObject({
    workspace: {
      description: "Where it runs.",
      type: "object",
      properties: {
        kind: { enum: ["project", "new_worktree", "existing_worktree"] },
        base: { type: "object" },
        path: { type: "string" },
      },
      required: ["kind"],
    },
    access: { type: "string", enum: ["inherit", "read-only", "full-access"] },
  });
  // The output schema a client reads is trimmed the same way and stays open to extra keys.
  expect(JSON.stringify(tool?.outputSchema)).not.toMatch(/additionalProperties|\$schema|maximum/);
});

it("a call that fits the flat schema but not its variant is refused before running, naming the field", async () => {
  const { registry, runs } = example();
  const call = (input: unknown) =>
    registry.call("ace_example", input, lease().principal, new AbortController().signal);
  const refused = await call({ workspace: { kind: "new_worktree" } });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toContain("workspace.base");
  const secret = await call({ query: "secret" });
  expect(JSON.stringify(secret.content)).toContain("query must not be secret.");
  expect(runs).toEqual([]);
  expect((await call({ workspace: { kind: "new_worktree", base: { ref: "main" } } })).isError).toBe(
    undefined,
  );
  expect(runs).toHaveLength(1);
});

it("control tools advertise no generic envelope output schema", () => {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  agentControlToolkit({ execute: async () => ({ ok: true }) }).register(registry);
  const tools = registry.list(lease().principal);
  expect(tools.map((tool) => tool.name)).toContain("delegate");
  for (const tool of tools) expect(tool.outputSchema).toBeUndefined();
});

const Item = z.strictObject({ id: z.string().regex(/^[a-z]+$/), size: z.number().int().max(5) });
function bounded() {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  const runs: unknown[] = [];
  registry.register({
    name: "ace_bounded",
    description: "Example",
    capability: null,
    timeoutMs: 1000,
    input: z.strictObject({
      ref: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z]+$/),
      seconds: z.number().int().min(1).max(3600).default(60),
      tags: z.array(z.string()).min(1).max(64).optional(),
      kinds: z
        .array(z.enum(["a", "b"]))
        .max(2)
        .optional(),
      mode: z.enum(["fast", "slow"]).default("fast").describe("Default: fast, or slow."),
      speed: z.enum(["fast", "slow"]).default("fast").describe("slow waits for the disk."),
      items: z
        .union([Item, z.array(Item).max(4)])
        .optional()
        .describe("One or several."),
    }),
    output: z.strictObject({ ok: z.boolean() }),
    async run(input) {
      runs.push(input);
      return { ok: true };
    },
  });
  const call = (input: unknown) =>
    registry.call("ace_bounded", input, lease().principal, new AbortController().signal);
  return { registry, runs, call };
}
const issues = (result: { content: unknown }) =>
  z
    .object({ issues: z.array(z.object({ path: z.string(), expected: z.string() })) })
    .parse(JSON.parse(z.array(z.object({ text: z.string() })).parse(result.content)[0]?.text ?? ""))
    .issues;

it("models read no patterns, generous bounds or descriptions that only restate the choices", () => {
  const [tool] = bounded().registry.list(lease().principal);
  const properties = z.record(z.string(), z.unknown()).parse(tool?.inputSchema.properties);
  expect(properties).toEqual({
    ref: { type: "string" },
    seconds: { type: "integer", default: 60 },
    tags: { type: "array", items: { type: "string" } },
    kinds: { type: "array", items: { type: "string", enum: ["a", "b"] } },
    // type stays beside enum: Gemini's schema subset refuses an enum without one.
    mode: { type: "string", enum: ["fast", "slow"], default: "fast" },
    speed: {
      type: "string",
      enum: ["fast", "slow"],
      default: "fast",
      description: "slow waits for the disk.",
    },
    // One item or a list of them reads as the list alone; small bounds a model might cross stay.
    items: {
      description: "One or several.",
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: { id: { type: "string" }, size: { type: "integer", maximum: 5 } },
        required: ["id", "size"],
      },
    },
  });
});

it("a call breaking a bound the schema left out is refused, naming the bound, and nothing runs", async () => {
  const { call, runs } = bounded();
  const refused = await call({ ref: "Not valid", seconds: 7200, tags: [] });
  expect(refused.isError).toBe(true);
  expect(issues(refused)).toEqual(
    expect.arrayContaining([
      { path: "ref", expected: "a string matching /^[a-z]+$/" },
      { path: "seconds", expected: "number <= 3600" },
      { path: "tags", expected: "array >= 1 in length" },
    ]),
  );
  expect(runs).toEqual([]);
});

it("the full schema still decodes every call: a bare item stays a bare item", async () => {
  const { call, runs } = bounded();
  expect((await call({ ref: "abc", items: { id: "one", size: 1 } })).isError).toBe(undefined);
  expect((await call({ ref: "abc", items: [{ id: "one", size: 1 }] })).isError).toBe(undefined);
  expect(runs).toEqual([
    { ref: "abc", seconds: 60, mode: "fast", speed: "fast", items: { id: "one", size: 1 } },
    { ref: "abc", seconds: 60, mode: "fast", speed: "fast", items: [{ id: "one", size: 1 }] },
  ]);
});
