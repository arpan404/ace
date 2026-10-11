import { expect, test } from "vitest";
import {
  compareSnapshots,
  parseSnapshot,
  schemaId,
  type JsonSchema,
  type Snapshot,
} from "./index.ts";

function exclusive(definitions: Record<string, JsonSchema>): Snapshot {
  return {
    protocolVersion: 1,
    schemas: {
      Message: {
        $id: schemaId("Message"),
        oneOf: [{ type: "object", $defs: definitions }, { type: "null" }],
      },
    },
  };
}

function definition(name: string): string {
  return `${schemaId("Message")}#/oneOf/0/$defs/${name}`;
}

test("identical exclusive branches with recursive local definitions remain compatible", () => {
  const before = exclusive({
    Node: { type: "object", properties: { next: { $ref: definition("Node") } } },
  });
  const after = parseSnapshot(JSON.parse(JSON.stringify(before)));
  expect(compareSnapshots(before, after)).toEqual([]);
});

test("identical exclusive branches with shared definition graphs complete within the comparison budget", () => {
  const definitions: Record<string, JsonSchema> = {};
  for (let index = 0; index <= 17; index++) {
    definitions[`N${index}`] =
      index === 17
        ? { type: "string" }
        : {
            type: "object",
            properties: {
              left: { $ref: definition(`N${index + 1}`) },
              right: { $ref: definition(`N${index + 1}`) },
            },
          };
  }
  const before = exclusive(definitions);
  const after = parseSnapshot(JSON.parse(JSON.stringify(before)));
  expect(compareSnapshots(before, after)).toEqual([]);
});

test("a recursive definition does not hide a changed referenced constraint", () => {
  const before = exclusive({
    Node: {
      type: "object",
      properties: {
        next: { $ref: definition("Node") },
        value: { $ref: schemaId("Values") },
      },
    },
  });
  before.schemas.Values = {
    $id: schemaId("Values"),
    type: "object",
    additionalProperties: { type: "string" },
  };
  const after = parseSnapshot(JSON.parse(JSON.stringify(before)));
  expect(compareSnapshots(before, after)).toEqual([]);
  after.schemas.Values = { $id: schemaId("Values"), type: "object" };
  expect(compareSnapshots(before, after)).toContainEqual(
    expect.objectContaining({ schema: "Message", kind: "review" }),
  );
});
