import { expect, it } from "vitest";
import { z } from "zod";
import { ThreadListView, ScreenUITreeResult } from "@ace/protocol";
import { convertSchemas, jsonValidator, schemaId } from "./index.ts";

it("opaque-key decoding keeps its JSON contract without losing own prototype-like keys", () => {
  const source = ThreadListView.shape.threads;
  const validate = jsonValidator(
    convertSchemas([{ name: "OpaqueThreads", schema: source }]),
  ).getSchema(schemaId("OpaqueThreads"));
  const thread = {
    id: "thread",
    workspaceId: "workspace",
    title: "Example",
    provider: "codex",
    status: { state: "working", agents: 1 },
    createdAt: 0,
    updatedAt: 0,
  };
  const value: unknown = JSON.parse(JSON.stringify({ constructor: thread }));
  expect(source.safeParse(value).success).toBe(true);
  expect(validate?.(value)).toBe(true);
  expect(validate?.({ constructor: { id: 7 } })).toBe(false);
});
it("recursive UI references validate nodes while the source enforces the aggregate budget", () => {
  const node = {
    ref: "example",
    role: "button",
    name: "Example",
    bounds: { x: 0, y: 0, w: 10, h: 10 },
    states: [],
    actions: ["press"],
    children: [],
  };
  const source = ScreenUITreeResult;
  const validate = jsonValidator(convertSchemas([{ name: "UITree", schema: source }])).getSchema(
    schemaId("UITree"),
  );
  const value = { nodes: [{ ...node, children: [node] }], truncated: false };
  expect(source.safeParse(value).success).toBe(true);
  expect(validate?.(value)).toBe(true);
  expect(
    validate?.({ nodes: [{ ...node, children: [{ ...node, ref: 7 }] }], truncated: false }),
  ).toBe(false);
  expect(
    source.safeParse({ nodes: Array.from({ length: 257 }, () => value.nodes[0]), truncated: false })
      .success,
  ).toBe(false);
});
it("unannotated transforms still fail with their owning export", () => {
  expect(() =>
    convertSchemas([
      { name: "Undocumented", schema: z.string().transform((value) => value.length) },
    ]),
  ).toThrow("Schema Undocumented:");
});
