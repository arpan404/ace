// SPDX-License-Identifier: Apache-2.0

/*
 * Generates `native/daemon/catalog/routes.json`, the transport's one route table (ADR 0226,
 * docs/transport/porting-guide.md rule 4): each client message type's owner and each listener's
 * HTTP stages in chain order. The message types come from `@ace/protocol`'s client message
 * schemas, which stay the one source of truth; the owners come from `scripts/transport-owners.ts`,
 * the one place ownership changes. The output is committed, never hand-edited, and
 * `bun run check:daemon-native` regenerates it and fails on a diff.
 *
 *   bun scripts/generate-transport-routes.ts [--check]
 *
 * Each root below is a schema the daemon's sockets accept. The walk recurses into a union's
 * options; an object contributes its `type` field's literal (or every value of a literal union
 * or an enum). Anything else fails, naming the schema, so a new shape is never silently left
 * without an owner. Every definition of a type is compared: one root may define a type with
 * several shapes (a reply's ok and error variants), but two roots may share a type only when
 * they share its schema objects (or, failing identity, its JSON Schema); a type they define
 * differently fails, naming both.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BrowserBackendClientMessage,
  BrowserClientMessage,
  ClientMessage,
  ServerMessage,
  UserBrowserExtensionMessage,
} from "@ace/protocol";
import { MarketClientMessage } from "@ace/protocol/marketplace";
import { PluginClientMessage } from "@ace/protocol/plugins";
import { SuitClientMessage, SuitReportMessage } from "@ace/protocol/suits";
import { httpStages, messageOwners, serverMessageOwners, type Owner } from "./transport-owners.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * The schemas whose message types the daemon accepts, one line per entry point named in the
 * porting guide. `SocketMessage` in `apps/daemon/src/services/socket.ts` is the union of them.
 * `ServerMessage` is the other direction: every type the daemon can send, so a new one has an
 * owner (Rust or TypeScript) the moment it exists.
 */
const messageSchemas: readonly { name: string; schema: z.core.$ZodType }[] = [
  { name: "ClientMessage", schema: ClientMessage },
  { name: "BrowserClientMessage", schema: BrowserClientMessage },
  { name: "BrowserBackendClientMessage", schema: BrowserBackendClientMessage },
  { name: "UserBrowserExtensionMessage", schema: UserBrowserExtensionMessage },
  { name: "PluginClientMessage", schema: PluginClientMessage },
  { name: "SuitClientMessage", schema: SuitClientMessage },
  { name: "SuitReportMessage", schema: SuitReportMessage },
  { name: "MarketClientMessage", schema: MarketClientMessage },
  { name: "ServerMessage", schema: ServerMessage },
];

/** Every distinct schema object seen for one `type` value, with the roots that define it. */
interface FoundTag {
  readonly schemas: Map<z.core.$ZodType, Set<string>>;
}

/** Every `type` value the field allows, or `null` when it isn't a literal or an enum of them. */
function typeValues(field: z.core.$ZodType): readonly string[] | null {
  if (field instanceof z.ZodLiteral) {
    if (field.values.size === 0) return null;
    const values: string[] = [];
    for (const value of field.values) {
      if (typeof value !== "string") return null;
      values.push(value);
    }
    return values;
  }
  if (field instanceof z.ZodEnum) {
    const values: string[] = [];
    for (const value of field.options) {
      if (typeof value !== "string") return null;
      values.push(value);
    }
    return values;
  }
  if (field instanceof z.ZodUnion) {
    const values: string[] = [];
    for (const option of field.options) {
      const nested = typeValues(option);
      if (nested === null) return null;
      values.push(...nested);
    }
    return values.length === 0 ? null : values;
  }
  return null;
}

function record(
  type: string,
  rootName: string,
  object: z.core.$ZodType,
  found: Map<string, FoundTag>,
): void {
  let tag = found.get(type);
  if (tag === undefined) {
    tag = { schemas: new Map() };
    found.set(type, tag);
  }
  let roots = tag.schemas.get(object);
  if (roots === undefined) {
    roots = new Set();
    tag.schemas.set(object, roots);
  }
  roots.add(rootName);
}

/** A root's definitions as JSON Schema strings, or `null` when one can't be written out. */
function canonical(schemas: readonly z.core.$ZodType[]): string[] | null {
  try {
    return schemas.map((schema) =>
      JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" })),
    );
  } catch {
    return null;
  }
}

/** Why two roots define one type differently, or `null` when they define it the same way. */
function differs(
  first: readonly z.core.$ZodType[],
  second: readonly z.core.$ZodType[],
): string | null {
  // The same schema objects reached through several roots, the usual spread.
  if (first.length === second.length) {
    const shared = new Set(first);
    if (second.every((schema) => shared.has(schema))) return null;
  }
  const left = canonical(first);
  const right = canonical(second);
  if (left === null || right === null) return "their schemas could not be compared";
  // Multisets, sorted and compared element by element with their counts: two variants that
  // serialize alike can't stand in for two different ones.
  const sortedLeft = left.toSorted();
  const sortedRight = right.toSorted();
  if (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((json, index) => json === sortedRight[index])
  )
    return null;
  return "their schemas differ";
}

/**
 * A type's several shapes may live in one root (the reply's ok and error variants); a type
 * more than one root defines must be the same definition in each.
 */
function conflicts(found: Map<string, FoundTag>): string[] {
  const problems: string[] = [];
  for (const [type, tag] of found) {
    const byRoot = new Map<string, z.core.$ZodType[]>();
    for (const [schema, roots] of tag.schemas) {
      for (const rootName of roots) {
        const schemas = byRoot.get(rootName);
        if (schemas === undefined) byRoot.set(rootName, [schema]);
        else schemas.push(schema);
      }
    }
    const [first, ...rest] = [...byRoot];
    if (first === undefined) continue;
    const [firstRoot, firstSchemas] = first;
    for (const [rootName, schemas] of rest) {
      const reason = differs(firstSchemas, schemas);
      if (reason !== null)
        problems.push(`${type} is defined differently by ${firstRoot} and ${rootName}: ${reason}`);
    }
  }
  return problems;
}

function walk(
  schema: z.core.$ZodType,
  rootName: string,
  found: Map<string, FoundTag>,
  problems: string[],
): void {
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) walk(option, rootName, found, problems);
    return;
  }
  if (schema instanceof z.ZodObject) {
    const field: z.core.$ZodType | undefined = schema.shape["type"];
    if (field === undefined) {
      problems.push(`${rootName}: an object has no \`type\` field`);
      return;
    }
    const values = typeValues(field);
    if (values === null) {
      problems.push(
        `${rootName}: an object's \`type\` field is ${field.constructor.name}, not a literal or an enum of literals`,
      );
      return;
    }
    for (const value of values) record(value, rootName, schema, found);
    return;
  }
  problems.push(`${rootName}: ${schema.constructor.name} is neither a union nor an object`);
}

/** A declared override, or `js:main`; `Object.hasOwn`, so no prototype key answers for a tag. */
function ownerOf(type: string): Owner {
  if (Object.hasOwn(messageOwners, type)) return messageOwners[type] ?? "js:main";
  return "js:main";
}

/** A server message's declared producer, or the TypeScript main thread. */
function serverOwnerOf(type: string): Owner {
  if (Object.hasOwn(serverMessageOwners, type)) return serverMessageOwners[type] ?? "js:main";
  return "js:main";
}

function generate(): string {
  const found = new Map<string, FoundTag>();
  const server = new Map<string, FoundTag>();
  const problems: string[] = [];
  for (const { name, schema } of messageSchemas) {
    walk(schema, name, name === "ServerMessage" ? server : found, problems);
  }
  problems.push(...conflicts(found));
  problems.push(...conflicts(server));
  for (const type of Object.keys(messageOwners).toSorted()) {
    if (!found.has(type))
      problems.push(`scripts/transport-owners.ts names ${type}, which no client schema defines`);
  }
  for (const type of Object.keys(serverMessageOwners).toSorted()) {
    if (!server.has(type))
      problems.push(`scripts/transport-owners.ts names ${type}, which no server schema defines`);
  }
  if (problems.length > 0)
    throw new Error(`the transport route table cannot be generated:\n  ${problems.join("\n  ")}`);

  // Entries through `Object.fromEntries`, so a tag such as `__proto__` is an ordinary own key.
  const messages: Record<string, Owner> = Object.fromEntries(
    [...found.keys()].toSorted().map((type): [string, Owner] => [type, ownerOf(type)]),
  );
  const serverMessages: Record<string, Owner> = Object.fromEntries(
    [...server.keys()].toSorted().map((type): [string, Owner] => [type, serverOwnerOf(type)]),
  );
  const http = httpStages.map(({ listener, stage, owner }) => ({ listener, stage, owner }));
  return `${JSON.stringify({ messages, serverMessages, http }, null, 2)}\n`;
}

const target = join(root, "native", "daemon", "catalog", "routes.json");
const generated = generate();
if (process.argv.includes("--check")) {
  let committed: string;
  try {
    committed = readFileSync(target, "utf8");
  } catch {
    throw new Error(`${target} is missing; run bun scripts/generate-transport-routes.ts`);
  }
  if (generated !== committed)
    throw new Error(`${target} is stale; run bun scripts/generate-transport-routes.ts`);
  console.log("catalog/routes.json is fresh");
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, generated);
  console.log(`wrote ${target}`);
}
