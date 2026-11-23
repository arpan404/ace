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
 * without an owner. A type two roots both define is a failure; one root's several shapes for a
 * type (a reply's ok and error variants) are one message.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BrowserBackendClientMessage,
  BrowserClientMessage,
  ClientMessage,
  UserBrowserExtensionMessage,
} from "@ace/protocol";
import { MarketClientMessage } from "@ace/protocol/marketplace";
import { PluginClientMessage } from "@ace/protocol/plugins";
import { SuitClientMessage, SuitReportMessage } from "@ace/protocol/suits";
import { httpStages, messageOwners, type Owner } from "./transport-owners.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * The schemas whose message types the daemon accepts, one line per entry point named in the
 * porting guide. `SocketMessage` in `apps/daemon/src/services/socket.ts` is the union of them.
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
];

interface FoundType {
  readonly schema: string;
  readonly object: z.core.$ZodType;
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
  schema: string,
  object: z.core.$ZodType,
  found: Map<string, FoundType>,
  problems: string[],
): void {
  const previous = found.get(type);
  if (previous === undefined) {
    found.set(type, { schema, object });
    return;
  }
  // The same schema reached through another root (`BrowserClientMessage`'s options are also
  // spread into `ClientMessage`) is the same definition.
  if (previous.object === object) return;
  // One message may have several shapes inside one root: `UserBrowserReply` answers ok or an
  // error under the same `user_browser.reply`. Two roots defining one type is a real conflict.
  if (previous.schema === schema) return;
  problems.push(`${type} is defined by two schemas, ${previous.schema} and ${schema}`);
}

function walk(
  schema: z.core.$ZodType,
  rootName: string,
  found: Map<string, FoundType>,
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
    for (const value of values) record(value, rootName, schema, found, problems);
    return;
  }
  problems.push(`${rootName}: ${schema.constructor.name} is neither a union nor an object`);
}

function generate(): string {
  const found = new Map<string, FoundType>();
  const problems: string[] = [];
  for (const { name, schema } of messageSchemas) walk(schema, name, found, problems);
  for (const type of Object.keys(messageOwners).toSorted()) {
    if (!found.has(type))
      problems.push(`scripts/transport-owners.ts names ${type}, which no schema defines`);
  }
  if (problems.length > 0)
    throw new Error(`the transport route table cannot be generated:\n  ${problems.join("\n  ")}`);

  const messages: Record<string, Owner> = {};
  for (const type of [...found.keys()].toSorted())
    messages[type] = messageOwners[type] ?? "js:main";
  const http = httpStages.map(({ listener, stage, owner }) => ({ listener, stage, owner }));
  return `${JSON.stringify({ messages, http }, null, 2)}\n`;
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
