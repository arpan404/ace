import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createTranslator as claudeTranslator } from "@ace/adapter-claude";
import { createCodexAdapter } from "@ace/adapter-codex";
import { createCursorAdapter } from "@ace/adapter-cursor";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { readFixture } from "@ace/adapter-testkit";
import { apply, createThreadState, type CoreConfig, type Fact } from "@ace/core";
import type { ProviderAdapter } from "@ace/engine-api";
import { Event, type EventPayload, type ThreadId } from "@ace/protocol";
import { z } from "zod";
import { decodeStoredPayload } from "../src/stored-decode.ts";

/**
 * How much of the history an older build wrote the idle trust pass (ADR 0125) would confirm
 * under this build's schema. The recorded provider sessions run through this build's adapters;
 * each payload is stored as the older build would have stored it (canonicalised by its own
 * `Event` schema), then checked the way the pass checks a row. Extract the older protocol
 * first, inside the repo so it resolves the same zod:
 *
 *   git archive <commit> packages/protocol/src | tar -x -C apps/daemon/.cache/old-protocol/<commit>
 *   bun apps/daemon/bench/stored-trust-compat.ts apps/daemon/.cache/old-protocol/<commit>
 */
const root = process.argv[2];
if (!root) throw new Error("usage: stored-trust-compat.ts <old protocol root>");
const old: { Event: z.ZodType<{ payload: unknown }> } = await import(
  resolve(root, "packages/protocol/src/index.ts")
);
const fingerprint = (schema: z.ZodType) =>
  JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any", io: "output", cycles: "ref" }));

const fixtures = join(import.meta.dirname, "../../../fixtures");
const recordings: {
  dir: string;
  createTranslator: ProviderAdapter["createTranslator"];
  config: CoreConfig;
}[] = [
  {
    dir: "claude/2.1.286",
    createTranslator: claudeTranslator,
    config: { provider: "claude", silenceMs: 60_000 },
  },
  {
    dir: "codex/0.159.1",
    createTranslator: createCodexAdapter().createTranslator,
    config: { provider: "codex", silenceMs: 90_000 },
  },
  {
    dir: "opencode/2.0.22/muse-spark-1.3-contributor",
    createTranslator: createOpenCodeAdapter().createTranslator,
    config: { provider: "opencode", liveness: "transport", silenceMs: 25_000 },
  },
  {
    dir: "cursor-sdk/1.0.35/composer-2.5",
    createTranslator: createCursorAdapter().createTranslator,
    config: { provider: "cursor", silenceMs: 90_000 },
  },
];

async function payloadsOf(
  file: string,
  createTranslator: ProviderAdapter["createTranslator"],
  config: CoreConfig,
): Promise<EventPayload[]> {
  const fixture = await readFixture(file);
  const threads = fixture.threads ? Object.entries(fixture.threads) : [["root", fixture.frames]];
  const payloads: EventPayload[] = [];
  for (const [threadKey, frames] of threads) {
    // Trusted: a bench-made id.
    const threadId = `thread-${String(threadKey)}` as ThreadId;
    const state = createThreadState({ threadId, config });
    const translator = createTranslator({ threadId, rootKey: "root" });
    let id = 0;
    const ids = { next: (kind: string) => `${kind}-${++id}` };
    const fold = (facts: Fact[], now: number) => {
      for (const fact of facts) payloads.push(...apply(state, fact, { now, ids }));
    };
    for (const frame of frames as typeof fixture.frames) {
      fold(translator.translate(structuredClone(frame), frame.t), frame.t);
      fold(translator.tick(frame.t), frame.t);
      fold([{ type: "tick" }], frame.t);
    }
  }
  return payloads;
}

const counts = { rows: 0, notStorable: 0, confirmed: 0, changed: 0 };
const changedTypes = new Map<string, number>();
let seq = 0;
for (const { dir, createTranslator, config } of recordings)
  for (const name of readdirSync(join(fixtures, dir))) {
    const file = join(fixtures, dir, name);
    if (!name.endsWith(".jsonl") || !statSync(file).isFile()) continue;
    for (const payload of await payloadsOf(file, createTranslator, config)) {
      counts.rows++;
      let json: string;
      try {
        const stored = old.Event.parse({
          seq: ++seq,
          id: `event-${seq}`,
          threadId: "thread-root",
          at: 1,
          payload,
        });
        json = JSON.stringify(stored.payload);
      } catch {
        counts.notStorable++;
        continue;
      }
      const value: unknown = JSON.parse(json);
      let same = false;
      try {
        const decoded = decodeStoredPayload(value);
        same = isDeepStrictEqual(decoded, value) && JSON.stringify(decoded) === json;
      } catch {
        same = false;
      }
      if (same) counts.confirmed++;
      else {
        counts.changed++;
        changedTypes.set(payload.type, (changedTypes.get(payload.type) ?? 0) + 1);
      }
    }
  }
const storable = counts.rows - counts.notStorable;
console.log(
  JSON.stringify(
    {
      shapeDiffers: fingerprint(old.Event) !== fingerprint(Event),
      ...counts,
      confirmedShare: +(counts.confirmed / storable).toFixed(4),
      changedTypes: Object.fromEntries([...changedTypes].toSorted((a, b) => b[1] - a[1])),
    },
    null,
    2,
  ),
);
