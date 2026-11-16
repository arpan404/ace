import type { InstallPorts, PluginAvailabilityState } from "./install.ts";
import type { StoredInstall } from "./store.ts";

/*
 * An install's journal (ADR 0168 §8: nothing is half installed). Before each step that changes
 * something outside the marketplace's own rows (the Suit library, the plugin manager, a bot's
 * plugins, a new bot), the step and what it replaces are written down durably; undoing is built
 * from that record alone, so a failure, or a crash and the next start, puts everything back. A
 * journal is dropped once its install commits, or once every one of its steps is undone.
 */

export type JournalStep =
  /** A marketplace row written: put back `previous`, or drop it. */
  | { kind: "record"; type: string; name: string; previous?: StoredInstall | undefined }
  /** A Suit put into the library over `previousHash` (pinned), or new. */
  | { kind: "suit"; name: string; previousHash?: string | undefined }
  /** A plugin accepted over the version the manager had, with its availability then. */
  | {
      kind: "plugin";
      name: string;
      previous?: { hash: string; commit: string; version: string; source: string } | undefined;
      availability?: PluginAvailabilityState | undefined;
    }
  /** A bot's allowed plugins as they were before this install changed them. */
  | { kind: "bot-plugins"; bot: string; plugins: string[] }
  /** A bot Spade makes under `transaction`; `id` once Spade said it. */
  | { kind: "bot"; transaction: string; id?: string | undefined };

export interface Journal {
  id: string;
  steps: JournalStep[];
}

export class Transaction {
  readonly id: string;
  readonly #ports: InstallPorts;
  readonly #steps: JournalStep[] = [];

  constructor(ports: InstallPorts, id: string) {
    this.#ports = ports;
    this.id = id;
  }

  /** Writes `step` down before it is taken. */
  note(step: JournalStep): JournalStep {
    this.#steps.push(step);
    this.#save();
    return step;
  }

  /** Records what a step learned while it ran, such as the bot's id. */
  learned(): void {
    this.#save();
  }

  #save(): void {
    this.#ports.store.saveJournal({ id: this.id, steps: this.#steps });
  }

  commit(): void {
    this.#ports.store.dropJournal(this.id);
  }

  /** Undoes every step, newest first. */
  rollback(): Promise<boolean> {
    return undoJournal(this.#ports, { id: this.id, steps: this.#steps });
  }
}

async function undo(ports: InstallPorts, step: JournalStep): Promise<void> {
  const { store } = ports;
  switch (step.kind) {
    case "record":
      if (step.previous) store.saveInstall(step.previous);
      else store.removeInstall(step.type, step.name);
      return;
    case "suit": {
      const suits = ports.suits;
      if (!suits) throw new Error("The Suit library isn't ready");
      if (step.previousHash)
        await suits.install(step.name, await store.pinned(step.previousHash, "suit"), {
          replace: true,
        });
      else await suits.remove(step.name);
      return;
    }
    case "plugin": {
      const plugins = ports.plugins;
      if (!plugins) throw new Error("Plugins aren't ready");
      const now = await plugins.accepted(step.name);
      if (step.previous) {
        // The version accepted before goes back, from the bytes pinned when it was accepted.
        if (now?.hash !== step.previous.hash) {
          const review = await plugins.prepareFiles({
            name: step.name,
            hash: step.previous.hash,
            commit: step.previous.commit,
            origin: { repository: step.previous.source, ref: step.previous.version },
            files: await store.pinned(step.previous.hash, "spade-plugin"),
          });
          await plugins.accept({ id: review.id, commit: review.commit, hash: review.hash });
        }
        if (step.availability) await plugins.setAvailability(step.name, step.availability);
      } else if (now) await plugins.remove(step.name);
      return;
    }
    case "bot-plugins":
      await ports.spade.setPlugins(step.bot, step.plugins);
      return;
    case "bot": {
      const id = step.id ?? (await ports.spade.findBot(step.transaction));
      if (id) await ports.spade.deleteBot(id);
      return;
    }
  }
}

/**
 * Undoes a journal's steps, newest first. A step that can't be undone now (Spade away, say)
 * stays in the journal for the next try; the rest are done with. True when nothing is left.
 */
export async function undoJournal(ports: InstallPorts, journal: Journal): Promise<boolean> {
  const left: JournalStep[] = [];
  for (const step of journal.steps.toReversed())
    try {
      await undo(ports, step);
    } catch {
      left.unshift(step);
    }
  if (left.length === 0) ports.store.dropJournal(journal.id);
  else ports.store.saveJournal({ id: journal.id, steps: left });
  return left.length === 0;
}

/** Hashes a journal still needs pinned to undo its steps. */
export function journalHashes(journal: Journal): string[] {
  return journal.steps.flatMap((step) =>
    step.kind === "record" && step.previous
      ? [step.previous.hash]
      : step.kind === "suit" && step.previousHash
        ? [step.previousHash]
        : step.kind === "plugin" && step.previous
          ? [step.previous.hash]
          : [],
  );
}
