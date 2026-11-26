// SPDX-License-Identifier: Apache-2.0

/*
 * `check:wire-fixtures` (ADR 0226 §3): the wire contract's proof over data the repository
 * already has. Nothing here is a case of its own: the samples are the protocol's canonical
 * event table and the recorded provider sessions, replayed through their translator, the core
 * reducer and the projection exactly as `apps/daemon/bench/wire-trims.ts` does.
 *
 *   bun scripts/check-wire-fixtures.ts
 *
 * Inbound, every sample is parsed by Zod and decoded by the generated Rust type; both must
 * accept or both reject, and when accepted the values (Zod's output, Rust's canonical shape)
 * must be the same JSON text. Outbound, the same message is written by the TypeScript encoder
 * (`JSON.stringify`, `WireEncoder`) and by `ace-wire` through `ace-json`; the bytes must be
 * identical. Zod's answer stands: a mismatch is a Rust bug, never a changed fixture.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apply, createThreadState, type Fact } from "../packages/core/src/index.ts";
import { readFixture } from "../packages/adapter-testkit/src/index.ts";
import { applyEvent, createThreadView } from "../packages/projection/src/index.ts";
import { Event, ServerMessage, Thread, type ThreadView } from "@ace/protocol";
import { samples as canonicalSamples } from "../apps/daemon/src/canonical-event-samples.ts";
import { WireEncoder } from "../apps/daemon/src/wire-encoder.ts";
import { replayProviders } from "../apps/daemon/bench/adapter-replay-fixtures.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** One message both sides must agree on. */
interface WireSample {
  source: string;
  /** The JSON text as a daemon would send it, or as a client sent it. */
  text: string;
  kind: "client" | "server";
}

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
      });
    }
  }
  return found;
}

/** The Rust side of one sample: whether it decoded, and its canonical text. */
interface RustAnswer {
  ok: boolean;
  canonical?: string;
  error?: string;
}

function rustCheck(
  kind: "client" | "server",
  op: "decode" | "encode",
  texts: string[],
): RustAnswer[] {
  const requests = texts.map((text) => JSON.stringify({ op, kind, text })).join("\n");
  const output = execFileSync(join(binary(), "ace-wire-fixtures"), [], {
    input: `${requests}\n`,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RustAnswer);
}

/** The debug binary, built on the pinned toolchain the workspace names. */
function binary(): string {
  const target = process.env.CARGO_TARGET_DIR ?? join(root, "native", "daemon", "target");
  const profile = join(target, "debug");
  execFileSync(cargo(), ["build", "--quiet", "-p", "ace-wire", "--bin", "ace-wire-fixtures"], {
    cwd: join(root, "native", "daemon"),
    stdio: "inherit",
    env: cargoEnv(),
  });
  return profile;
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
function zodCheck(text: string): RustAnswer {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const parsed = ServerMessage.safeParse(value);
  if (!parsed.success) return { ok: false };
  return { ok: true, canonical: JSON.stringify(parsed.data) };
}

/** TypeScript's bytes for a parsed message, as the daemon sends them. */
function tsBytes(text: string): string | undefined {
  const parsed = ServerMessage.safeParse(JSON.parse(text));
  if (!parsed.success) return undefined;
  return new WireEncoder().encode(parsed.data);
}

const mismatches: string[] = [];
const bound = 12;
function differ(source: string, what: string, expected: string, actual: string): void {
  if (mismatches.length < bound)
    mismatches.push(`${source}: ${what}\n  expected ${expected}\n  actual   ${actual}`);
}

const samples = [...canonicalEvents(), ...(await recordedSessions())];
const texts = samples.map((sample) => sample.text);

// Inbound: Zod versus the generated type.
const inbound = rustCheck("server", "decode", texts);
let accepted = 0;
for (const [index, sample] of samples.entries()) {
  const zod = zodCheck(sample.text);
  const rust = inbound[index];
  if (zod.ok !== rust.ok) {
    differ(
      sample.source,
      `accept (zod ${zod.ok}, rust ${rust.ok}${rust.error === undefined ? "" : `: ${rust.error}`})`,
      String(zod.ok),
      String(rust.ok),
    );
    continue;
  }
  if (!zod.ok) continue;
  accepted += 1;
  if (zod.canonical !== rust.canonical)
    differ(sample.source, "value", zod.canonical ?? "", rust.canonical ?? "");
}

// Outbound: ace-json's bytes versus the TypeScript encoder's.
const outbound = rustCheck("server", "encode", texts);
let encoded = 0;
for (const [index, sample] of samples.entries()) {
  const expected = tsBytes(sample.text);
  if (expected === undefined) continue;
  encoded += 1;
  const rust = outbound[index];
  if (!rust.ok) {
    differ(sample.source, "encode", "bytes", rust.error ?? "refused");
    continue;
  }
  if (expected !== rust.canonical) differ(sample.source, "bytes", expected, rust.canonical ?? "");
}

if (mismatches.length > 0)
  throw new Error(
    `check:wire-fixtures: ${mismatches.length}+ mismatches\n\n${mismatches.join("\n\n")}`,
  );

console.log(
  `check:wire-fixtures: ${samples.length} samples, ${accepted} accepted inbound, ${encoded} encoded outbound, identical`,
);
