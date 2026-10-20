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
