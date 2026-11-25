// SPDX-License-Identifier: Apache-2.0
//
// From the repo root, run `bun scripts/stored-command-vectors.ts` after editing
// Command. Commit both generated files. Pass --check to verify them without writing.

import { readFileSync, writeFileSync } from "node:fs";
import { Command, CommandPayload } from "@ace/protocol";
import type { z } from "zod";
import { iconUrlCases, refinementRejections } from "./stored-command-refinement-vectors.ts";
import {
  assertProjectIconUrlRules,
  commandSchema,
  definition,
  refinementNames,
} from "./stored-command-schema.ts";

type Fields = Record<string, unknown>;

function sample(schema: z.core.$ZodType): unknown {
  const def = definition(schema);
  switch (def.type) {
    case "optional":
    case "default":
      return undefined;
    case "nullable":
    case "null":
    case "unknown":
      return null;
    case "literal":
      return def.values[0];
    case "enum":
      return Object.values(def.entries)[0];
    case "boolean":
      return true;
    case "union": {
      const first = def.options[0];
      return first ? sample(first) : missingSample(def.type);
    }
    case "record":
      return {};
    case "intersection":
      return Object.assign({}, sample(def.left), sample(def.right));
    case "number": {
      const candidates = [0, 1, -1, 2, 5, 10, 16, 32, 50, 100, 2048, 16384, 65536];
      return candidates.find((value) => accepts(schema, value)) ?? missingSample(def.type);
    }
    case "string": {
      const candidates = [
        "x",
        "1",
        "a".repeat(40),
        "a".repeat(64),
        "11111111-2222-3333-4444-555555555555",
        "https://example.test/icon.png",
      ];
      return candidates.find((value) => accepts(schema, value)) ?? missingSample(def.type);
    }
    case "array":
      for (const size of [0, 1, 2, 3]) {
        const items = Array.from({ length: size }, () => sample(def.element));
        if (accepts(schema, items)) return items;
      }
      return missingSample(def.type);
    case "object": {
      const fields = Object.fromEntries(
        Object.entries(def.shape).flatMap(([key, child]) => {
          const value = sample(child);
          return value === undefined ? [] : [[key, value]];
        }),
      );
      if (fields.type === "forge.pr.unlink") fields.all = true;
      if (!accepts(schema, fields))
        throw new Error(`Invalid generated sample ${JSON.stringify(fields)}`);
      return fields;
    }
    default:
      return missingSample(def.type);
  }
}

function missingSample(type: string): never {
  throw new Error(`No sample for ${type}`);
}

function accepts(schema: z.core.$ZodType, value: unknown): boolean {
  // The inputs are the actual classic Zod instances returned by the protocol schemas.
  return (schema as z.ZodType).safeParse(value).success;
}

function unwrap(schema: z.core.$ZodType): z.core.$ZodType {
  const def = definition(schema);
  return def.type === "optional" || def.type === "default" ? unwrap(def.innerType) : schema;
}

const cases: { name: string; input: string; output: string | null }[] = [];
function add(name: string, input: unknown) {
  const text = JSON.stringify(input);
  const parsed = Command.safeParse(JSON.parse(text));
  cases.push({ name, input: text, output: parsed.success ? JSON.stringify(parsed.data) : null });
  return parsed;
}

function addPayload(name: string, payload: Fields) {
  // Reverse the input key order so an encoder that preserves input order fails.
  return add(name, {
    payload: Object.fromEntries(Object.entries(payload).toReversed()),
    deviceId: "device",
    id: "command",
    ignored: 1,
  });
}

for (const variant of CommandPayload.options) {
  const baseline = sample(variant);
  if (!baseline || typeof baseline !== "object" || !("type" in baseline))
    throw new Error("Command payload sample must be a tagged object");
  const tag = String(baseline.type);
  addPayload(`${tag}/minimum`, baseline);
  if (cases.at(-1)?.output === null) throw new Error(`Missing valid sample for ${tag}`);
  addPayload(`${tag}/extra`, { ...baseline, ignored: true });
  for (const [key, schema] of Object.entries(variant.shape)) {
    if (key === "type") continue;
    if (Object.hasOwn(baseline, key)) {
      const absent: Fields = { ...baseline };
      delete absent[key];
      addPayload(`${tag}/missing ${key}`, absent);
    } else {
      const value = sample(unwrap(schema));
      addPayload(`${tag}/with ${key}`, { ...baseline, [key]: value });
    }
    addPayload(`${tag}/wrong ${key}`, { ...baseline, [key]: { invalidType: true } });
  }
}

const send = { type: "thread.send", threadId: "thread", input: [{ type: "text", text: "hi" }] };
const create = {
  type: "thread.create",
  workspaceId: "workspace",
  provider: "codex",
  input: send.input,
};
const fork = {
  type: "thread.fork",
  threadId: "thread",
  input: "hi",
  point: { type: "turn", runId: "run" },
};
const device = {
  type: "device",
  id: "d",
  name: "Mac",
  kind: "laptop",
  machine: { id: "host", name: "Host", here: true },
};
const explicit: [string, Fields][] = [
  ["unknown command", { type: "thread.unknown" }],
  ["missing tag", {}],
  ["nonstring tag", { type: 0 }],
  ["text missing text", { ...send, input: [{ type: "text" }] }],
  ["text wrong text", { ...send, input: [{ type: "text", text: 1 }] }],
  ["unknown content part", { ...send, input: [{ type: "unknown" }] }],
  [
    "text strips extra keys and preserves UTF-16",
    { ...send, input: [{ extra: 1, text: "\ud800", type: "text" }] },
  ],
  [
    "send has no schema maximum for parts",
    { ...send, input: Array.from({ length: 65 }, () => send.input[0]) },
  ],
  ["context defaults", { ...send, context: { ignored: true } }],
  ["context invalid draft", { ...send, context: { draftId: "bad draft" } }],
  ["context unknown item", { ...send, context: { items: [{ type: "unknown" }] } }],
  [
    "context item budget defaults",
    { ...send, context: { items: [{ type: "thread_ref", threadId: "other" }] } },
  ],
  ["context incomplete item", { ...send, context: { items: [{ type: "thread_ref" }] } }],
  ["context strict item", { ...send, context: { items: [{ ...device, ignored: true }] } }],
  [
    "context strict machine",
    { ...send, context: { items: [{ ...device, machine: { ...device.machine, ignored: true } }] } },
  ],
  ["context device", { ...send, context: { items: [device] } }],
  ["context invalid mention", { ...send, context: { mentions: [{}] } }],
  ["context invalid attachment", { ...send, context: { attachments: [{}] } }],
  [
    "context reversed mention line range",
    {
      ...send,
      context: { mentions: [{ path: "file", label: "file", lines: { start: 2, end: 1 } }] },
    },
  ],
  ["create account and handoff", { ...create, accountId: "account", handoffFrom: "source" }],
  ["create empty account", { ...create, accountId: "" }],
  ["create oversized account", { ...create, accountId: "🌱".repeat(129) }],
  ["create account Unicode boundary", { ...create, accountId: "🌱".repeat(128) }],
  ["create empty handoff", { ...create, handoffFrom: "" }],
  ["create option intersection", { ...create, options: { misc: 1, effort: "high", z: true } }],
  [
    "create option intersection rejects invalid launch control",
    { ...create, options: { serviceTier: "bogus" } },
  ],
  [
    "resume strips extras",
    { type: "thread.resume", threadId: "thread", expectedRevision: 0, ignored: 1 },
  ],
  [
    "limit rejects missing action",
    { type: "thread.limit", threadId: "thread", expectedRevision: 0 },
  ],
  [
    "fork defaults budget and strips in point",
    { ...fork, point: { ...fork.point, ignored: true } },
  ],
  ["fork unknown point", { ...fork, point: { type: "tail" } }],
  ["fork item point", { ...fork, point: { type: "item", itemId: "item" } }],
  ...[2047, 2048, 2048.5, 65536, 65537, "16384"].map((budgetBytes): [string, Fields] => [
    `fork budget ${budgetBytes}`,
    { ...fork, budgetBytes },
  ]),
  ...[-1, 0.25, 9007199254740991, 9007199254740992].map((expectedRevision): [string, Fields] => [
    `resume revision ${expectedRevision}`,
    { type: "queue.resume", threadId: "thread", expectedRevision },
  ]),
  [
    "record preserves JS key order and drops __proto__",
    { ...send, options: JSON.parse('{"b":1,"2":2,"1":1,"a":true,"__proto__":1}') },
  ],
  [
    "record rejects too many keys",
    {
      ...send,
      options: Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`option${index}`, index]),
      ),
    },
  ],
];
for (const [name, payload] of explicit) addPayload(name, payload);
add("missing device id", { id: "command", payload: send });
add("missing command id", { deviceId: "device", payload: send });
add("missing payload", { id: "command", deviceId: "device" });
add("wrong command id", { id: "", deviceId: "device", payload: send });
add("wrong root type", []);

// For a union, only one arm needs to reach the predicate. Within that arm the
// refinement must be the sole reason for rejection.
function hasOnlyCustomIssue(issues: readonly z.core.$ZodIssue[]): boolean {
  const [issue] = issues;
  if (issues.length !== 1 || !issue) return false;
  if (issue.code === "custom") return true;
  return issue.code === "invalid_union" && issue.errors.some(hasOnlyCustomIssue);
}

assertProjectIconUrlRules();
if (Object.keys(refinementRejections).toSorted().join() !== refinementNames().join())
  throw new Error("Every stored command refinement needs a rejection case");
for (const [name, payload] of Object.entries(refinementRejections)) {
  const result = addPayload(`refinement/${name}`, payload);
  if (result.success || !hasOnlyCustomIssue(result.error.issues))
    throw new Error(`refinement/${name} must be rejected by a custom rule alone`);
}
for (const [index, icon] of iconUrlCases.entries()) {
  addPayload(`project icon URL/${index + 1}`, { type: "workspace.add", path: "/project", icon });
}

function write(name: string, contents: string): void {
  const path = new URL(`../native/daemon/crates/ace-engine/${name}`, import.meta.url);
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== contents)
      throw new Error(`${name} is stale. Run bun scripts/stored-command-vectors.ts`);
  } else {
    writeFileSync(path, contents);
  }
}

write("tests/fixtures/stored-command-cases.json", `${JSON.stringify(cases)}\n`);
write("src/intents/command/schema.json.inc", `${JSON.stringify(commandSchema(Command))}\n`);
console.log(`${cases.length} cases across ${CommandPayload.options.length} stored command kinds`);
