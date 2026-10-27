import {
  readViewed,
  settleDraft,
  storedViewed,
  StoredDraft,
  withViewed,
  type DraftStore,
  type ReviewDraft,
  type ViewedFiles,
} from "@ace/ui-core/review";
import { z } from "zod";
import type { KeptValue } from "./kept-value.ts";

/*
 * What the Changes sheet keeps on this phone between launches (the `review` kept value): review
 * drafts, which files were viewed at which version of their diff, and the diff layout. Read
 * once; every change is written back, one save at a time. The host caps a kept value at 1 MiB,
 * so the oldest resolved drafts, then the oldest of any, give way when it would not fit.
 */

export type DiffLayout = "unified" | "split";

/** Drafts kept, newest first, as the web keeps them. */
const maxDrafts = 400;
/** Characters of JSON kept: below the host's 1 MiB cap with room for multi-byte text. */
const maxKeptLength = 320_000;

const Kept = z.object({
  v: z.literal(1),
  drafts: z.array(z.unknown()).catch([]),
  viewed: z.unknown(),
  layout: z.enum(["unified", "split"]).catch("unified"),
});

const byNewest = (a: ReviewDraft, b: ReviewDraft) => b.createdAt - a.createdAt;

/** The kept drafts that fit: newest first, dropping resolved ones before open ones. */
function fitting(drafts: readonly ReviewDraft[], room: number): ReviewDraft[] {
  const kept = drafts.toSorted(byNewest).slice(0, maxDrafts);
  let size = JSON.stringify(kept).length;
  while (size > room && kept.length) {
    const at = kept.findLastIndex((draft) => draft.state === "resolved");
    const [dropped] = kept.splice(at >= 0 ? at : kept.length - 1, 1);
    size -= JSON.stringify(dropped).length + 1;
  }
  return kept;
}

export class ChangesKept implements DraftStore {
  #value: KeptValue;
  #drafts: readonly ReviewDraft[] = [];
  #viewed: ViewedFiles = new Map();
  #layout: DiffLayout = "unified";
  #listeners = new Set<() => void>();
  #loading: Promise<void> | undefined;
  #saving: Promise<void> | undefined;
  #again = false;

  constructor(value: KeptValue) {
    this.#value = value;
  }

  /** Read what was kept, once; drafts written meanwhile stay, and in-flight ones settle. */
  load(): Promise<void> {
    this.#loading ??= this.#value.load().then(
      (raw) => {
        const kept = Kept.safeParse(raw);
        if (!kept.success) return;
        const stored = kept.data.drafts.flatMap((entry) => {
          const draft = StoredDraft.safeParse(entry);
          return draft.success
            ? [settleDraft(draft.data, "the app closed before ace confirmed")]
            : [];
        });
        const fresh = new Set(this.#drafts.map((draft) => draft.key));
        this.#drafts = [...this.#drafts, ...stored.filter((draft) => !fresh.has(draft.key))];
        this.#viewed = new Map([...(readViewed(kept.data.viewed) ?? []), ...this.#viewed]);
        this.#layout = kept.data.layout;
        this.#changed(false);
      },
      () => undefined,
    );
    return this.#loading;
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

  /** Settles once everything changed so far is written. */
  flushed(): Promise<void> {
    return this.#saving ?? Promise.resolve();
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
    // Never write over what was kept before it was read.
    this.#saving = this.load()
      .then(() => {
        const viewed = storedViewed(this.#viewed);
        const room = maxKeptLength - JSON.stringify(viewed).length;
        const drafts = fitting(this.#drafts, room);
        return this.#value.save({ v: 1, drafts, viewed, layout: this.#layout });
      })
      .catch(() => undefined)
      .finally(() => {
        this.#saving = undefined;
        if (this.#again) {
          this.#again = false;
          this.#save();
        }
      });
  }
}
