// SPDX-License-Identifier: Apache-2.0
/**
 * The shared scaffolding of the seam tests on TypeScript-written homes: the seeded thread ids,
 * the queue-updated counter, the two seeds and a provider echo.
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Command } from "@ace/protocol";
import { engineBackend } from "@ace/provider-kit/native-switches";
import type { Store } from "../../store.ts";
import { engineSeam, type EngineSeam } from "../testing.ts";

export const native = engineBackend() === "native";
export const queueChild = join(fileURLToPath(new URL(".", import.meta.url)), "commands-home.ts");
export const inputsChild = join(fileURLToPath(new URL(".", import.meta.url)), "inputs-home.ts");

/** The seeded threads, oldest first. */
export function threads(store: Store): string[] {
  return (
    store.atomic((db) => db.prepare("SELECT id FROM threads ORDER BY rowid").all()) as {
      id: string;
    }[]
  ).map((row) => row.id);
}

export function queueUpdated(store: Store, id: string): number {
  const row = store.atomic((db) =>
    db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE thread_id=? AND type='queue.updated'")
      .get(id),
  ) as { n: number };
  return Number(row.n);
}

export async function seeded(): Promise<{
  seam: EngineSeam;
  queue: string;
  stale: string;
  fate: string;
  edits: string;
  held: string;
  heldBehind: string;
  guest: string;
  bot: string;
  host: string;
  selecting: string;
}> {
  const seam = await engineSeam({ seedWithTypeScript: { script: queueChild } });
  await seam.engine.ready().catch(() => {});
  // E5.3's scaffolding: collaborators later items own answer pass-through until they land.
  seam.probe.passThroughCollaborators();
  const [queue, stale, fate, edits, held, heldBehind, guest, bot, host, selecting] = threads(
    seam.store,
  ) as [string, string, string, string, string, string, string, string, string, string];
  return { seam, queue, stale, fate, edits, held, heldBehind, guest, bot, host, selecting };
}

export async function seededInputs(): Promise<{ seam: EngineSeam; thread: string }> {
  const seam = await engineSeam({ seedWithTypeScript: { script: inputsChild } });
  const rows = threads(seam.store);
  if (rows.length !== 1) throw new Error(`the seed wrote ${String(rows.length)} threads`);
  // E5.4's rounds do not recover threads (E5.8 does): the seam's ready settles its own refusal,
  // and these tests read the home through the probe either way.
  await seam.engine.ready().catch(() => {});
  return { seam, thread: rows[0]! };
}

/** One echo of a provider's user message. */
export function echo(text: string, item = "native-item", extra: Record<string, unknown> = {}) {
  return {
    type: "item.upsert",
    agent: "root",
    item,
    draft: {
      type: "message",
      role: "user",
      parts: [{ type: "text", text }],
      ...extra,
    },
  };
}

/** A command as the protocol parses it. */
export function receipt(payload: Record<string, unknown>, id = "cmd"): never {
  return Command.parse({ id, deviceId: "device", payload }) as never;
}
