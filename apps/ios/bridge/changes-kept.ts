import {
  readViewed,
  settleDraft,
  StoredDraft,
  withViewed,
  type DraftStore,
  type ReviewDraft,
  type ViewedFiles,
} from "@ace/ui-core/review";
import { z } from "zod";
import { fitKept } from "./changes-kept-fit.ts";
import { readKept, retryDelay, type KeptRead, type Timers } from "./kept-read.ts";
import type { KeptValue } from "./kept-value.ts";

/*
 * What the Changes sheet keeps on this phone between launches (the `review` kept value): review
 * drafts, which files were viewed at which version of their diff, and the diff layout. Read
 * until a read succeeds; nothing is saved before that, so a failed read never wipes what was
 * kept. Every change is written back, one save at a time, within the host's 1 MiB
 * (`changes-kept-fit.ts`). `trouble` says in words when this phone can't keep the review now.
 */

export type DiffLayout = "unified" | "split";

const Kept = z.object({
  v: z.literal(1),
  drafts: z.array(z.unknown()).catch([]),
  viewed: z.unknown(),
  layout: z.enum(["unified", "split"]).catch("unified"),
});

const unread =
  "Couldn't read the review kept on this phone: trying again. New comments stay here meanwhile.";
const unsaved =
  "Couldn't save review comments on this phone: trying again. They stay here while ace is open.";

/** Unsent drafts that don't fit the host's cap: the reason is shown as it is. */
class TooLarge extends Error {}

export class ChangesKept implements DraftStore {
  #value: KeptValue;
  #timers: Timers;
  #drafts: readonly ReviewDraft[] = [];
  #viewed: ViewedFiles = new Map();
  #layout: DiffLayout = "unified";
  #listeners = new Set<() => void>();
  #reading: KeptRead | undefined;
  #loaded: Promise<void> | undefined;
  #saving: Promise<void> | undefined;
  #again = false;
  #readTrouble = "";
  #saveTrouble = "";
  #saveFailures = 0;
  #retry: (() => void) | undefined;

  constructor(value: KeptValue, timers: Timers) {
    this.#value = value;
    this.#timers = timers;
  }

  /** Why this phone can't keep the review right now, in words; "" when it can. */
  get trouble(): string {
    return this.#readTrouble || this.#saveTrouble;
  }

  /** Settles after the first read attempt, whether or not it read. */
  tried(): Promise<void> {
    this.load();
    return this.#reading?.tried ?? Promise.resolve();
  }

  /**
   * Settles once what was kept is read (retrying after failures); drafts written meanwhile stay,
   * and in-flight ones settle.
   */
  load(): Promise<void> {
    if (this.#loaded) return this.#loaded;
    this.#reading = readKept(this.#value, this.#timers, (failed) => {
      this.#readTrouble = failed ? unread : "";
      this.#changed(false);
    });
    this.#loaded = this.#reading.read.then((raw) => this.#merge(raw));
    return this.#loaded;
  }

  get(): readonly ReviewDraft[] {
    return this.#drafts;
  }
  set(next: (previous: readonly ReviewDraft[]) => readonly ReviewDraft[]): void {
    this.#drafts = next(this.#drafts);
    this.#changed(true);
  }
  get viewed(): ViewedFiles {
    return this.#viewed;
  }
  /** Mark `path` viewed at `version`, or clear it (`undefined`). */
  view(threadId: string, path: string, version: string | undefined): void {
    this.#viewed = withViewed(this.#viewed, threadId, path, version);
    this.#changed(true);
  }
  get layout(): DiffLayout {
    return this.#layout;
  }
  set layout(layout: DiffLayout) {
    if (layout === this.#layout) return;
    this.#layout = layout;
    this.#changed(true);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Settles once everything changed so far is written (or its save failed). */
  flushed(): Promise<void> {
    return this.#saving ?? Promise.resolve();
  }

  #merge(raw: unknown): void {
    const kept = Kept.safeParse(raw);
    if (!kept.success) {
      this.#changed(false);
      return;
    }
    const stored = kept.data.drafts.flatMap((entry) => {
      const draft = StoredDraft.safeParse(entry);
      return draft.success ? [settleDraft(draft.data, "the app closed before ace confirmed")] : [];
    });
    const fresh = new Set(this.#drafts.map((draft) => draft.key));
    const adopted = stored.filter((draft) => !fresh.has(draft.key));
    // A comment read from the daemon before the kept drafts were is the kept draft itself.
    const recorded = new Set(adopted.flatMap((draft) => draft.commentId ?? []));
    this.#drafts = [
      ...this.#drafts.filter((draft) => !draft.commentId || !recorded.has(draft.commentId)),
      ...adopted,
    ];
    this.#viewed = new Map([...(readViewed(kept.data.viewed) ?? []), ...this.#viewed]);
    this.#layout = kept.data.layout;
    this.#changed(false);
  }

  #changed(save: boolean): void {
    for (const listener of this.#listeners) listener();
    if (save) this.#save();
  }

  #save(): void {
    if (this.#saving) {
      this.#again = true;
      return;
    }
    this.#retry?.();
    this.#retry = undefined;
    // Never write over what was kept before it was read.
    this.#saving = this.load()
      .then(() => {
        const fitted = fitKept(this.#drafts, this.#viewed);
        if (!fitted.ok) throw new TooLarge(fitted.reason);
        return this.#value.save({
          v: 1,
          drafts: fitted.drafts,
          viewed: fitted.viewed,
          layout: this.#layout,
        });
      })
      .then(
        () => {
          this.#saveFailures = 0;
          this.#trouble("");
        },
        (error: unknown) => {
          this.#saveFailures++;
          this.#trouble(error instanceof TooLarge ? error.message : unsaved);
          // The host refused or failed: try again later, unless a change saves sooner.
          this.#retry = this.#timers.set(retryDelay(this.#saveFailures), () => {
            this.#retry = undefined;
            this.#save();
          });
        },
      )
      .finally(() => {
        this.#saving = undefined;
        if (this.#again) {
          this.#again = false;
          this.#save();
        }
      });
  }

  #trouble(message: string): void {
    if (message === this.#saveTrouble) return;
    this.#saveTrouble = message;
    this.#changed(false);
  }
}
