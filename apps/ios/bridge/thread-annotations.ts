import type { ClientCore } from "@ace/client";
import {
  browserAnnotationLimit,
  type BrowserAnnotation,
  type ContentPart,
  type MessageContext,
  type ThreadId,
} from "@ace/protocol";
import { annotationContextItems, formatBrowserAnnotations } from "@ace/ui-core";
import type { Preview } from "./agents.ts";
import {
  AttachmentTray,
  type ChunkReader,
  type Picked,
  type TrayRow,
} from "./thread-attachments.ts";

/*
 * The browser annotations of the open thread's next message (ADR 0082), the phone's side of the
 * web's draft annotations: each pinned record, its element crop and one screenshot per page,
 * staged on the phone and uploaded into the thread as they arrive. On send they become the
 * `<browser_annotations>` block after the person's words, the images after the person's files in
 * the block's order, and a context item per annotated tab. They live as long as the thread's
 * session; the daemon keeps none of them.
 */

interface Item {
  annotation: BrowserAnnotation;
  crop: Picked | undefined;
  /** The crop is still being captured or staged. */
  capturing: boolean;
}

/** What `send` takes from the draft's annotations. */
export interface AnnotationHandOff {
  part: ContentPart;
  /** Every image's SHA-256, in the block's order. */
  attachments: string[];
  items: MessageContext["items"];
}

/** The page's annotate mode, told when the draft closes ranks or empties. */
export interface AnnotationPage {
  removed(rest: readonly BrowserAnnotation[], id: string): void;
  cleared(): void;
}

export class ThreadAnnotations {
  #items: Item[] = [];
  #pages = new Map<string, Picked>();
  #tray: AttachmentTray;
  #rows = new Map<string, TrayRow>();
  #emit: (patch: Record<string, unknown>) => void;
  #preview: Preview;
  /** The browser's annotate mode on this thread's page, while it is on. */
  overlay: AnnotationPage | undefined;
  constructor(
    client: Pick<ClientCore, "request">,
    threadId: ThreadId,
    signal: AbortSignal,
    emit: (patch: Record<string, unknown>) => void,
    read: ChunkReader,
    preview: Preview,
  ) {
    this.#emit = emit;
    this.#preview = preview;
    this.#tray = new AttachmentTray(
      client,
      { threadId },
      signal,
      (rows) => {
        this.#rows = new Map(rows.map((row) => [String(row.id), row]));
        this.#publish();
      },
      read,
    );
  }
  get count(): number {
    return this.#items.length;
  }
  annotations(): BrowserAnnotation[] {
    return this.#items.map((item) => item.annotation);
  }
  /** A pinned comment, new or edited; a new one's crop follows once captured and staged. */
  save(annotation: BrowserAnnotation, crop?: Promise<Picked | undefined>): void {
    const known = this.#items.find((item) => item.annotation.id === annotation.id);
    if (known) {
      known.annotation = annotation;
      this.#publish();
      return;
    }
    if (this.#items.length >= browserAnnotationLimit) return;
    const item: Item = { annotation, crop: undefined, capturing: crop !== undefined };
    this.#items.push(item);
    this.#publish();
    void crop
      ?.then(
        (picked) => {
          // Removed while it was captured: nothing to attach.
          if (!this.#items.includes(item) || !picked) return;
          item.crop = picked;
          this.#tray.attach(picked);
        },
        () => {},
      )
      .finally(() => {
        item.capturing = false;
        this.#publish();
      });
  }
  /** A fresh screenshot of `url` with its markers; the one it replaces is let go. */
  pageShot(url: string, capture: Promise<Picked | undefined>): void {
    void capture.then(
      (picked) => {
        if (!picked || !this.#items.some((item) => item.annotation.url === url)) return;
        const previous = this.#pages.get(url);
        this.#pages.set(url, picked);
        this.#tray.attach(picked);
        if (previous) this.#tray.detach(previous.localId);
      },
      () => {},
    );
  }
  /** Records leave and the rest close ranks (1, 3 become 1, 2), as the page's markers do. */
  remove(id: string): void {
    const gone = this.#items.find((item) => item.annotation.id === id);
    if (!gone) return;
    this.#drop([gone]);
    this.overlay?.removed(this.annotations(), id);
  }
  clear(): void {
    if (!this.#items.length) return;
    this.#drop([...this.#items]);
    this.overlay?.cleared();
  }
  /** The overlay removed or discarded these itself: the draft follows without telling it. */
  removedOnPage(id: string): void {
    const gone = this.#items.find((item) => item.annotation.id === id);
    if (gone) this.#drop([gone]);
  }
  clearedOnPage(): void {
    this.#drop([...this.#items]);
  }

  /** Why the message can't go yet, or what it takes; undefined with no annotations. */
  handOff(): { refused: string } | AnnotationHandOff | undefined {
    if (!this.#items.length) return undefined;
    if (this.#items.some((item) => item.capturing) || this.#uploading())
      return { refused: "Wait for the annotation images to finish uploading." };
    const ready = (picked: Picked | undefined) =>
      !!picked && this.#rows.get(picked.localId)?.state === "ready";
    const crops = new Map(this.#items.map((item) => [item.annotation.id, item.crop]));
    const block = formatBrowserAnnotations(this.annotations(), {
      page: (url) => ready(this.#pages.get(url)),
      crop: (id) => ready(crops.get(id)),
    });
    if (!block) return undefined;
    const attachments = block.images.flatMap((image) => {
      const picked = image.kind === "page" ? this.#pages.get(image.url) : crops.get(image.id);
      return picked ? [picked.sha256] : [];
    });
    return {
      part: { type: "text", text: `\n\n${block.text}` },
      attachments,
      items: annotationContextItems(this.annotations()),
    };
  }
  /** The message went: the records leave the draft; the daemon keeps the images it holds. */
  sent(): void {
    this.#items = [];
    this.#pages.clear();
    this.#tray.sent();
    this.overlay?.cleared();
    this.#publish();
  }
  dispose(): void {
    this.#tray.dispose();
  }

  /** An image on its way: still uploading, or attached and not yet listed by the tray. */
  #uploading(): boolean {
    const settled = (picked: Picked | undefined) => {
      const state = picked ? this.#rows.get(picked.localId)?.state : "ready";
      return state === "ready" || state === "failed";
    };
    return (
      [...this.#rows.values()].some((row) => row.state === "uploading") ||
      this.#items.some((item) => !settled(item.crop)) ||
      [...this.#pages.values()].some((page) => !settled(page))
    );
  }
  #drop(gone: Item[]): void {
    this.#items = renumbered(this.#items.filter((item) => !gone.includes(item)));
    for (const item of gone) if (item.crop) this.#tray.detach(item.crop.localId);
    const urls = new Set(this.#items.map((item) => item.annotation.url));
    for (const [url, picked] of this.#pages)
      if (!urls.has(url)) {
        this.#pages.delete(url);
        this.#tray.detach(picked.localId);
      }
    this.#publish();
  }
  #publish(): void {
    const preview = this.#preview;
    this.#emit({
      type: "thread.annotations",
      items: this.#items.map((item) => ({
        id: item.annotation.id,
        number: item.annotation.number,
        comment: preview(item.annotation.comment, 256),
        region: item.annotation.kind === "region",
        label: preview(labelOf(item.annotation), 128),
        image: item.crop?.localId ?? null,
        state: item.capturing
          ? "uploading"
          : item.crop
            ? String(this.#rows.get(item.crop.localId)?.state ?? "uploading")
            : "ready",
      })),
    });
  }
}

/**
 * Numbers 1…n in their current order. Each item stays the same object (its record is replaced),
 * since a crop still being captured finishes into the item it was saved with.
 */
function renumbered(items: Item[]): Item[] {
  const order = items.toSorted((a, b) => a.annotation.number - b.annotation.number);
  for (const [index, item] of order.entries())
    if (item.annotation.number !== index + 1)
      item.annotation = { ...item.annotation, number: index + 1 };
  return items;
}

/** What the person pinned, as a chip names it: the element's tag and text, or a region. */
function labelOf(annotation: BrowserAnnotation): string {
  if (annotation.kind === "region") return "Area";
  const text = annotation.element.text.replace(/\s+/g, " ").trim();
  const tag = annotation.element.tag.toLowerCase();
  return text ? `${tag} “${text}”` : tag;
}

/** The message with its annotations: the block after the words, the images after the files. */
export function withAnnotations(
  input: ContentPart[],
  context: MessageContext | undefined,
  handOff: AnnotationHandOff | undefined,
): { input: ContentPart[]; context: MessageContext | undefined } {
  if (!handOff) return { input, context };
  const attachments = [
    ...(context?.attachments ?? []),
    ...handOff.attachments.map((sha256) => ({ sha256 })),
  ];
  const items = [...(context?.items ?? []), ...(handOff.items ?? [])];
  return {
    input: [...input, handOff.part],
    context: {
      ...context,
      mentions: context?.mentions ?? [],
      attachments,
      ...(items.length ? { items } : {}),
    },
  };
}
