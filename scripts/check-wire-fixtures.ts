// SPDX-License-Identifier: Apache-2.0

/*
 * `check:wire-fixtures` (ADR 0226 §3): the wire contract's proof. It runs over two kinds of
 * data the repository already has or derives from its schemas:
 *
 * - the canonical event table and the recorded provider sessions, replayed through their
 *   translator, the core reducer and the projection exactly as `apps/daemon/bench/wire-trims.ts`
 *   does;
 * - one synthesised value per client and server message type, plus mutations of it that move
 *   every bound, remove every required key, change every kind and add unknown keys.
 *
 * Inbound, Zod's answer stands: a sample is accepted or rejected as Zod accepts or rejects it,
 * and an accepted sample's output must be the same JSON. Outbound, the bytes `JSON.stringify`
 * and `ace-json` write must be identical, through both the value and the generated body.
 *
 *   bun scripts/check-wire-fixtures.ts
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { apply, createThreadState, type Fact } from "../packages/core/src/index.ts";
import { readFixture } from "../packages/adapter-testkit/src/index.ts";
import { applyEvent, createThreadView } from "../packages/projection/src/index.ts";
import {
  BrowserBackendClientMessage,
  ClientMessage,
  Event,
  ServerMessage,
  Thread,
  UserBrowserExtensionMessage,
  type ThreadView,
} from "@ace/protocol";
import { samples as canonicalSamples } from "../apps/daemon/src/canonical-event-samples.ts";
import { WireEncoder } from "../apps/daemon/src/wire-encoder.ts";
import { replayProviders } from "../apps/daemon/bench/adapter-replay-fixtures.ts";
import { inputSchema, messageSchemas, mutations, repair, synthesize } from "./wire-samples.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** One message both sides must agree on. */
interface WireSample {
  source: string;
  kind: "client" | "server";
  text: string;
  /** A property-case mutation: compared only for accept/reject and value, never encoded. */
  property: boolean;
}

const clientSchemas = messageSchemas({
  ClientMessage,
  BrowserBackendClientMessage,
  UserBrowserExtensionMessage,
});
const serverSchemas = messageSchemas({ ServerMessage });
const clientZod = z.union([
  ClientMessage,
  BrowserBackendClientMessage,
  UserBrowserExtensionMessage,
]);
const serverZod = ServerMessage;

/** The canonical event table, each payload in an `events` message of its own. */
function canonicalEvents(): WireSample[] {
  const found: WireSample[] = [];
  for (const [variant, payload] of Object.entries(canonicalSamples)) {
    const event = Event.parse({
      seq: 1,
      id: `event-${variant}`,
      at: 1_700_000_000_000,
      threadId: "thread-1",
      payload,
    });
    found.push({
      source: `canonical-event/${variant}`,
      text: JSON.stringify({
        type: "events",
        subscriptionId: "check",
        afterSeq: 0,
        throughSeq: 1,
        events: [event],
      }),
      kind: "server",
      property: false,
    });
  }
  return found;
}

/** The recorded sessions, replayed as `wire-trims.ts` replays them. */
async function recordedSessions(): Promise<WireSample[]> {
  const found: WireSample[] = [];
  for (const [provider, replay] of Object.entries(replayProviders)) {
    for (const file of readdirSync(replay.directory).filter((name) => name.endsWith(".jsonl"))) {
      const fixture = await readFixture(`${replay.directory}${file}`);
      const thread = Thread.parse({
        id: "thread-1",
        workspaceId: "w",
        provider: replay.provider,
        title: file,
        status: { state: "new" },
        createdAt: 0,
        updatedAt: 0,
      });
      const state = createThreadState({
        threadId: thread.id,
        config: { provider: replay.provider, silenceMs: replay.silenceMs },
      });
      const translator = replay.createTranslator({ threadId: thread.id, rootKey: "root" });
      const view: ThreadView = createThreadView(thread);
      let id = 0;
      let seq = 0;
      const ids = { next: (kind: string) => `${kind}-${++id}` };
      const fold = (facts: Fact[]) => {
        for (const fact of facts)
          for (const payload of apply(state, fact, { now: 1_731_600_000_000, ids })) {
            const event = Event.parse({
              id: `01JXEVENT${String(++seq).padStart(17, "0")}`,
              seq,
              at: 1_731_600_000_000,
              threadId: thread.id,
              payload,
            });
            applyEvent(view, event);
            found.push({
              source: `${provider}/${file}/event-${seq}`,
              text: JSON.stringify({
                type: "events",
                subscriptionId: "check",
                afterSeq: seq - 1,
                throughSeq: seq,
                events: [event],
              }),
              kind: "server",
              property: false,
            });
          }
      };
      for (const frame of fixture.frames) {
        fold(translator.translate(structuredClone(frame), frame.t));
        fold(translator.tick(frame.t));
      }
      view.itemSeqs = Object.fromEntries(view.itemOrder.map((item, index) => [item, index + 1]));
      found.push({
        source: `${provider}/${file}/snapshot`,
        text: JSON.stringify({ type: "snapshot", subscriptionId: "check", seq: view.seq, view }),
        kind: "server",
        property: false,
      });
      found.push({
        source: `${provider}/${file}/items.page`,
        text: JSON.stringify({
          type: "items.page",
          requestId: "check",
          seq: view.seq,
          threadId: view.thread.id,
          items: view.itemOrder.slice(-200).flatMap((itemId) => view.items[itemId] ?? []),
          itemsBefore: null,
        }),
        kind: "server",
        property: false,
      });
    }
  }
  return found;
}

/** One synthesised value per message type, and its bound/kind/required-key mutations. */
function synthesized(): { samples: WireSample[]; refused: string[] } {
  const samples: WireSample[] = [];
  const refused: string[] = [];
  for (const [kind, schemas] of [
    ["client", clientSchemas],
    ["server", serverSchemas],
  ] as const) {
    for (const [type, schema] of schemas) {
      let value: unknown;
      try {
        value = synthesize(inputSchema(schema));
      } catch (error) {
        refused.push(`${kind}/${type}: ${String(error).slice(0, 200)}`);
        continue;
      }
      if (value === null || typeof value !== "object") {
        refused.push(`${kind}/${type}: synthesised a non-object`);
        continue;
      }
      (value as Record<string, unknown>).type = type;
      repair(type, value);
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        refused.push(
          `${kind}/${type}: ${issue?.path.join(".") || "<root>"} ${issue?.message ?? "rejected"}`,
        );
        continue;
      }
      samples.push({
        source: `synth/${kind}/${type}`,
        // The input as written, not Zod's output: inbound comparison proves Rust fills the
        // same defaults and strips the same keys as Zod, rather than agreeing on Zod's work.
        text: JSON.stringify(value),
        kind,
        property: false,
      });
      for (const [index, mutated] of mutations(parsed.data as unknown).entries()) {
        samples.push({
          source: `mutation/${kind}/${type}/${index}`,
          text: JSON.stringify(mutated),
          kind,
          property: true,
        });
      }
    }
  }
  return { samples, refused };
}

/** The Rust side's answer for one sample. */
interface RustAnswer {
  ok: boolean;
  canonical?: string;
  error?: string;
}

function rustCheck(
  kind: "client" | "server",
  op: "decode" | "encode" | "encode-body",
  texts: string[],
): RustAnswer[] {
  const requests = texts.map((text) => JSON.stringify({ op, kind, text })).join("\n");
  const output = execFileSync(join(binary(), "ace-wire-fixtures"), [], {
    input: `${requests}\n`,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RustAnswer);
}

let built = false;
/** The debug binary, built on the pinned toolchain the workspace names. */
function binary(): string {
  if (!built) {
    execFileSync(cargo(), ["build", "--quiet", "-p", "ace-wire", "--bin", "ace-wire-fixtures"], {
      cwd: join(root, "native", "daemon"),
      stdio: "inherit",
      env: cargoEnv(),
    });
    built = true;
  }
  const target = process.env.CARGO_TARGET_DIR ?? join(root, "native", "daemon", "target");
  return join(target, "debug");
}

let cargoPath: string | undefined;

function cargo(): string {
  if (cargoPath !== undefined) return cargoPath;
  const bin = pinnedToolchainBin();
  cargoPath =
    bin === undefined ? "cargo" : join(bin, process.platform === "win32" ? "cargo.exe" : "cargo");
  return cargoPath;
}

function cargoEnv(): NodeJS.ProcessEnv {
  const bin = pinnedToolchainBin();
  return {
    ...process.env,
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "3",
    ...(bin === undefined ? {} : { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }),
  };
}

function pinnedToolchainBin(): string | undefined {
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(
    readFileSync(join(root, "native", "daemon", "rust-toolchain.toml"), "utf8"),
  )?.[1];
  if (channel === undefined) return undefined;
  const home = process.env.RUSTUP_HOME ?? join(homedir(), ".rustup");
  const toolchain = readdirSync(join(home, "toolchains")).find((name) =>
    name.startsWith(`${channel}-`),
  );
  return toolchain === undefined ? undefined : join(home, "toolchains", toolchain, "bin");
}

/** Zod's answer for `text`: whether it parses, and its canonical text. */
function zodCheck(kind: "client" | "server", text: string): RustAnswer {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const parsed = kind === "client" ? clientZod.safeParse(value) : serverZod.safeParse(value);
  if (!parsed.success) return { ok: false };
  return { ok: true, canonical: JSON.stringify(parsed.data) };
}

/** The path of the first difference between two JSON values. */
function firstDifference(left: unknown, right: unknown, path = ""): string | null {
  if (sameJson(left, right)) return null;
  if (path !== "" && typeof left !== "object") return path;
  if (path !== "" && typeof right !== "object") return path;
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let position = 0; position < Math.max(left.length, right.length); position += 1) {
      const difference = firstDifference(left[position], right[position], `${path}[${position}]`);
      if (difference !== null) return difference;
    }
    return path;
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return path;
  const leftMap = left as Record<string, unknown>;
  const rightMap = right as Record<string, unknown>;
  for (const key of new Set([...Object.keys(leftMap), ...Object.keys(rightMap)])) {
    const difference = firstDifference(leftMap[key], rightMap[key], `${path}.${key}`);
    if (difference !== null) return difference;
  }
  return path;
}

/** Deep equality of two JSON values, key order ignored. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((item, index) => sameJson(item, right[index]))
    );
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftMap = left as Record<string, unknown>;
  const rightMap = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftMap);
  const rightKeys = Object.keys(rightMap);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(rightMap, key) && sameJson(leftMap[key], rightMap[key]))
  );
}

const mismatches: string[] = [];
const bound = 12;
function differ(source: string, what: string, expected: string, actual: string): void {
  if (mismatches.length < bound)
    mismatches.push(`${source}: ${what}\n  expected ${expected}\n  actual   ${actual}`);
}

const recorded = [...canonicalEvents(), ...(await recordedSessions())];
const generated = synthesized();
const samples = [...recorded, ...generated.samples];

// Inbound and property cases: Zod versus the generated type.
for (const kind of ["client", "server"] as const) {
  const ofKind = samples.filter((sample) => sample.kind === kind);
  const answers = rustCheck(
    kind,
    "decode",
    ofKind.map((sample) => sample.text),
  );
  for (const [index, sample] of ofKind.entries()) {
    const zod = zodCheck(kind, sample.text);
    const rust = answers[index];
    if (zod.ok !== rust?.ok) {
      differ(
        sample.source,
        `accept (zod ${zod.ok}, rust ${rust?.ok}${rust?.error === undefined ? "" : `: ${rust.error}`})`,
        String(zod.ok),
        String(rust?.ok),
      );
      continue;
    }
    if (zod.ok && zod.canonical !== rust?.canonical)
      differ(sample.source, "value", zod.canonical ?? "", rust?.canonical ?? "");
  }
}

// Outbound: ace-json's bytes versus the TypeScript encoder's, for every valid sample.
let encoded = 0;
for (const kind of ["client", "server"] as const) {
  const ofKind = samples.filter((sample) => sample.kind === kind && !sample.property);
  const answers = rustCheck(
    kind,
    "encode",
    ofKind.map((sample) => sample.text),
  );
  const bodies = rustCheck(
    kind,
    "encode-body",
    ofKind.map((sample) => sample.text),
  );
  for (const [index, sample] of ofKind.entries()) {
    const zod = zodCheck(kind, sample.text);
    if (!zod.ok) continue;
    encoded += 1;
    // What the daemon sends is Zod's output, in the schema's key order (a built object can
    // carry whatever order its producer used).
    const expected = new WireEncoder().encode(JSON.parse(zod.canonical ?? "null") as never);
    const rust = answers[index];
    if (rust?.canonical !== expected)
      differ(sample.source, "bytes", expected, rust?.canonical ?? rust?.error ?? "refused");
    // A typed body serializes in its struct's order; a loose object's Zod output keeps the
    // producer's order, which no typed value can know. The value path above proves the bytes;
    // the typed path proves the same value.
    const body = bodies[index];
    if (body?.canonical === undefined) {
      differ(sample.source, "typed bytes", expected, body?.error ?? "refused");
    } else if (!sameJson(JSON.parse(expected), JSON.parse(body.canonical))) {
      const path = firstDifference(JSON.parse(expected), JSON.parse(body.canonical)) ?? "";
      const at = (value: unknown): unknown =>
        path
          .replace(/^\./, "")
          .split(".")
          .filter((part) => part.length > 0)
          .reduce<unknown>((current, part) => {
            const key = part.replace(/\[(\d+)\]/g, "");
            const indexes = [...part.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
            let next = current as Record<string, unknown>;
            if (key.length > 0) next = next[key] as Record<string, unknown>;
            for (const position of indexes)
              next = (next as unknown as unknown[])[position] as Record<string, unknown>;
            return next;
          }, value);
      differ(
        sample.source,
        `typed value at ${path} (expected ${JSON.stringify(at(JSON.parse(expected)))} actual ${JSON.stringify(at(JSON.parse(body.canonical)))})`,
        expected,
        body.canonical,
      );
    }
  }
}

if (generated.refused.length > 0)
  throw new Error(
    `check:wire-fixtures: ${generated.refused.length} message types have no valid sample:\n  ${generated.refused.join("\n  ")}`,
  );
if (mismatches.length > 0)
  throw new Error(
    `check:wire-fixtures: ${mismatches.length}+ mismatches\n\n${mismatches.join("\n\n")}`,
  );

console.log(
  `check:wire-fixtures: ${samples.length} samples (${clientSchemas.size} client and ${serverSchemas.size} server types), ${encoded} encoded inbound/outbound, identical`,
);
