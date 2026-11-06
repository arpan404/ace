import type { Storage } from "@ace/client";
import { z } from "zod";

/** Just enough of a saved send to know which command it is and which daemon it is for. */
const Saved = z.object({ command: z.object({ id: z.string() }), hostId: z.string().optional() });
const idOf = (text: string): { id: string; hostId?: string | undefined } | undefined => {
  try {
    const saved = Saved.safeParse(JSON.parse(text));
    return saved.success ? { id: saved.data.command.id, hostId: saved.data.hostId } : undefined;
  } catch {
    return undefined;
  }
};
const entries = (text: string | null): unknown[] => {
  try {
    const parsed: unknown = JSON.parse(text ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/**
 * The outbox of an account machine standing in for this install's pairing of the same daemon
 * (ADR 0115): its own saved sends, plus the ones the pairing's outbox still holds for that
 * daemon, which it takes over. Each keeps its command id, so a send the pairing already
 * delivered is answered from its receipt and runs once. Only sends bound to `daemonId` move,
 * from a pairing outbox bound to it too: work for another daemon never leaves its own outbox.
 * Once the account machine's outbox has saved them, the pairing's outbox lets them go, so
 * the pairing coming back doesn't send them again.
 *
 * `own` is a whole-value outbox (`load`/`save`); its client lists the pairing's device id
 * among its aliases, so the moved sends load as its own.
 */
export function adoptedOutbox(
  own: Pick<Storage, "load" | "save">,
  pairing: Storage,
  daemonId: string,
): Storage {
  let taken: string[] = [];
  const pairingRecords = async (): Promise<readonly string[]> => {
    if (pairing.hostBinding && (await pairing.hostBinding.load()) !== daemonId) return [];
    if (pairing.records) return pairing.records.load();
    return entries(await pairing.load()).map((entry) => JSON.stringify(entry));
  };
  const release = async () => {
    const ids = new Set(taken);
    taken = [];
    if (ids.size === 0) return;
    if (pairing.records) {
      for (const id of ids) await pairing.records.write(id, null);
      return;
    }
    const kept = entries(await pairing.load()).filter(
      (entry) => !ids.has(idOf(JSON.stringify(entry))?.id ?? ""),
    );
    await pairing.save(JSON.stringify(kept));
  };
  return {
    async load() {
      const current = entries(await own.load());
      const seen = new Set(current.map((entry) => idOf(JSON.stringify(entry))?.id));
      let records: readonly string[] = [];
      try {
        records = await pairingRecords();
      } catch {
        // The pairing's outbox can't be read: its sends stay there, for the pairing.
      }
      const moved: unknown[] = [];
      for (const text of records) {
        const saved = idOf(text);
        if (!saved || saved.hostId !== daemonId || seen.has(saved.id)) continue;
        seen.add(saved.id);
        taken.push(saved.id);
        moved.push(JSON.parse(text));
      }
      return moved.length === 0 && current.length === 0
        ? await own.load()
        : JSON.stringify([...current, ...moved]);
    },
    async save(value) {
      await own.save(value);
      await release().catch(() => {
        // Left in the pairing's outbox: its command ids keep a second send from running twice.
      });
    },
  };
}
