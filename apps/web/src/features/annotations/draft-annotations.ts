import {
  annotationContextItems,
  boundedAnnotations,
  formatBrowserAnnotations,
  type DraftAnnotations,
} from "@ace/ui-core";
import {
  browserAnnotationLimit,
  type BrowserAnnotation,
  type BrowserAnnotationsContextItem,
  type ContentPart,
} from "@ace/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { composerPorts, type ComposerAnnotationPort } from "./store.ts";

/** A file the daemon holds, or why one couldn't be uploaded. */
export type AnnotationOutcome = { sha256: string; name: string } | { error: string };
type Held = { sha256: string; name: string };

/** One image of the draft's annotations: held by the daemon, on its way, or failed. */
interface Image {
  ready?: Held | undefined;
  pending?: Promise<AnnotationOutcome> | undefined;
  file?: File | undefined;
  failed?: boolean | undefined;
}
export interface AnnotationItem {
  annotation: BrowserAnnotation;
  crop?: Image | undefined;
  /** A local preview of the crop, while this page has its bytes. */
  preview?: string | undefined;
}
interface State {
  items: AnnotationItem[];
  pages: (Image & { url: string })[];
}

/** What a message being sent takes from the draft's annotations. */
export interface AnnotationHandOff {
  /** The `<browser_annotations>` block, as the text part after the person's words. */
  part: ContentPart;
  /** Its images, in the block's order, as the attachment pipeline carries files. */
  local: { name: string; mimeType: string; bytes: number; sha256?: string | undefined }[];
  outcomes: Promise<AnnotationOutcome>[];
  files: (File | undefined)[];
  /** The annotated tabs, so the agent gets each marker's element as a ref in its tab. */
  items: BrowserAnnotationsContextItem[];
  /** The annotations as a draft keeps them, for a message that comes back. */
  returned: DraftAnnotations;
  /** Put them back after a refused send. */
  restore(): void;
}

const fromDraft = (draft: DraftAnnotations | undefined): State => ({
  items: (draft?.items ?? []).map((item) =>
    item.crop
      ? { annotation: item.annotation, crop: { ready: item.crop } }
      : { annotation: item.annotation },
  ),
  pages: (draft?.pages ?? []).map((page) => ({
    url: page.url,
    ready: { sha256: page.sha256, name: page.name },
  })),
});

function draftOf(state: State): DraftAnnotations {
  return {
    items: state.items.map((item) => ({
      annotation: item.annotation,
      ...(item.crop?.ready ? { crop: item.crop.ready } : {}),
    })),
    pages: state.pages.flatMap((page) => (page.ready ? [{ url: page.url, ...page.ready }] : [])),
  };
}

const usable = (image: Image | undefined) =>
  !!image && (!!image.ready || (!!image.pending && !image.failed));
const held = (state: State) =>
  new Set(
    [...state.items.map((item) => item.crop?.ready), ...state.pages.map((page) => page.ready)]
      .filter((value) => value !== undefined)
      .map((value) => value.sha256),
  );
const settle = (image: Image, outcome: AnnotationOutcome): Image =>
  "sha256" in outcome
    ? { ready: outcome, file: image.file }
    : { ...image, pending: undefined, failed: true };
/** Numbers 1…n in their current order; an item keeps its object when its number holds. */
function renumbered(items: AnnotationItem[]): AnnotationItem[] {
  const order = items.toSorted((a, b) => a.annotation.number - b.annotation.number);
  const numbers = new Map(order.map((item, index) => [item, index + 1]));
  return items.map((item) => {
    const number = numbers.get(item) ?? item.annotation.number;
    return number === item.annotation.number
      ? item
      : { ...item, annotation: { ...item.annotation, number } };
  });
}
const mimeOf = (name: string) => (/\.jpe?g$/i.test(name) ? "image/jpeg" : "image/png");

/**
 * The browser annotations of the message being written (ADR 0082): their records, each one's
 * element crop and one screenshot per page, uploaded into the thread's context as they arrive.
 */
export function useDraftAnnotations(options: {
  restored: DraftAnnotations | undefined;
  upload(file: File): Promise<{ sha256: string }>;
  release(sha256: string): Promise<void>;
}) {
  const [state, setState] = useState<State>(() => fromDraft(options.restored));
  // Uploads settle between renders: every change reads and writes this copy first.
  const current = useRef(state);
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  const release = (shas: Iterable<string>) => {
    const used = held(current.current);
    for (const sha of shas) if (!used.has(sha)) void latest.current.release(sha).catch(() => {});
  };
  const forgetPreviews = (items: readonly AnnotationItem[]) => {
    for (const item of items)
      if (item.preview) {
        URL.revokeObjectURL(item.preview);
        previews.current.delete(item.preview);
      }
  };
  const update = (next: (state: State) => State) => {
    current.current = next(current.current);
    setState(current.current);
  };
  const upload = (file: File, done: (outcome: AnnotationOutcome) => void) =>
    latest.current
      .upload(file)
      .then(
        (result): AnnotationOutcome => ({ sha256: result.sha256, name: file.name }),
        (error: unknown): AnnotationOutcome => ({
          error: error instanceof Error ? error.message : "The upload failed",
        }),
      )
      .then((outcome) => {
        done(outcome);
        return outcome;
      });
  const patchItem = (id: string, patch: (item: AnnotationItem) => Partial<AnnotationItem>) =>
    update((now) => ({
      ...now,
      items: now.items.map((item) =>
        item.annotation.id === id ? { ...item, ...patch(item) } : item,
      ),
    }));

  const save = (annotation: BrowserAnnotation, crop?: Promise<File | undefined>) => {
    const id = annotation.id;
    if (current.current.items.some((item) => item.annotation.id === id))
      return patchItem(id, () => ({ annotation }));
    if (current.current.items.length >= browserAnnotationLimit) return;
    const pending = crop?.then(
      (file): Promise<AnnotationOutcome> | AnnotationOutcome => {
        if (!file) return { error: "The element couldn't be captured" };
        const preview =
          typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
        if (preview) previews.current.add(preview);
        patchItem(id, (item) => ({ preview, crop: { ...item.crop, file } }));
        return upload(file, (outcome) =>
          patchItem(id, (item) => ({ crop: settle(item.crop ?? {}, outcome) })),
        );
      },
      (): AnnotationOutcome => ({ error: "The element couldn't be captured" }),
    );
    void pending?.then((outcome) => {
      if ("error" in outcome) patchItem(id, (item) => ({ crop: settle(item.crop ?? {}, outcome) }));
    });
    update((now) => ({
      ...now,
      items: [...now.items, { annotation, ...(pending ? { crop: { pending } } : {}) }],
    }));
  };
  /** A new screenshot of `url`; the one it replaces is let go once the new one is held. */
  const page = (url: string, file: File) => {
    if (!current.current.items.some((item) => item.annotation.url === url)) return;
    const replaced = current.current.pages.find((entry) => entry.url === url)?.ready;
    const pending = upload(file, (outcome) => {
      update((now) => ({
        ...now,
        pages: now.pages.map((entry) =>
          entry.url === url && entry.pending === pending
            ? { url, ...settle(entry, outcome) }
            : entry,
        ),
      }));
      if (replaced) release([replaced.sha256]);
    });
    update((now) => ({
      ...now,
      pages: [...now.pages.filter((entry) => entry.url !== url), { url, pending, file }],
    }));
  };
  /**
   * Records leave and the rest close ranks (1, 3 becomes 1, 2, as the page's markers do); a
   * page none of the rest is on loses its screenshot too.
   */
  const drop = (ids: ReadonlySet<string> | "all") => {
    const before = current.current;
    const gone = before.items.filter((item) => ids === "all" || ids.has(item.annotation.id));
    if (!gone.length) return;
    update((now) => {
      const items = renumbered(now.items.filter((item) => !gone.includes(item)));
      const urls = new Set(items.map((item) => item.annotation.url));
      return { items, pages: now.pages.filter((entry) => urls.has(entry.url)) };
    });
    forgetPreviews(gone);
    release(held(before));
  };

  const port: Omit<ComposerAnnotationPort, "submit"> = {
    save,
    page,
    remove: (id) => drop(new Set([id])),
    clear: () => drop("all"),
    annotations: () => current.current.items.map((item) => item.annotation),
  };

  const handOff = (): AnnotationHandOff | undefined => {
    const taken = current.current;
    const crops = new Map(taken.items.map((item) => [item.annotation.id, item.crop]));
    const pages = new Map(taken.pages.map((entry) => [entry.url, entry]));
    const block = formatBrowserAnnotations(
      taken.items.map((item) => item.annotation),
      { page: (url) => usable(pages.get(url)), crop: (id) => usable(crops.get(id)) },
    );
    if (!block) return undefined;
    const images = block.images.flatMap((image) => {
      const found = image.kind === "page" ? pages.get(image.url) : crops.get(image.id);
      return found ? [found] : [];
    });
    forgetPreviews(taken.items);
    update(() => ({ items: [], pages: [] }));
    return {
      part: { type: "text", text: `\n\n${block.text}` },
      local: images.map((image) => {
        const name = image.ready?.name ?? image.file?.name ?? "annotation.png";
        return {
          name,
          mimeType: image.file?.type || mimeOf(name),
          bytes: image.file?.size ?? 0,
          ...(image.ready ? { sha256: image.ready.sha256 } : {}),
        };
      }),
      outcomes: images.map(
        (image) => image.pending ?? Promise.resolve(image.ready ?? { error: "it was removed" }),
      ),
      files: images.map((image) => image.file),
      items: annotationContextItems(taken.items.map((item) => item.annotation)),
      returned: draftOf(taken),
      restore: () =>
        update((now) => ({
          items: [
            ...taken.items.map((item) => ({ ...item, preview: undefined })),
            ...now.items,
          ].slice(0, browserAnnotationLimit),
          pages: [...taken.pages, ...now.pages.filter((entry) => !pages.has(entry.url))],
        })),
    };
  };

  return {
    /** The annotations as the stored draft keeps them (uploads the daemon holds). */
    draft: boundedAnnotations(draftOf(state)),
    count: state.items.length,
    items: state.items,
    remove: port.remove,
    clear: port.clear,
    /** What the thread's Browser reaches through `useAnnotationPort`. */
    port,
    /** Take another window's or a returned message's version as it is. */
    replace: (next: DraftAnnotations | undefined) => {
      forgetPreviews(current.current.items);
      update(() => fromDraft(next));
    },
    handOff,
  };
}

export type DraftAnnotationsState = ReturnType<typeof useDraftAnnotations>;

/**
 * Let the thread's Browser add to the draft's annotations and press Send while this composer
 * is mounted (an existing thread only: a new thread's draft has no Browser yet).
 */
export function useAnnotationPort(
  threadId: string | undefined,
  annotations: DraftAnnotationsState,
  submit: () => void,
): void {
  const latest = useRef({ port: annotations.port, submit });
  useLayoutEffect(() => {
    latest.current = { port: annotations.port, submit };
  });
  useEffect(() => {
    if (!threadId) return;
    return composerPorts.register(threadId, {
      save: (annotation, crop) => latest.current.port.save(annotation, crop),
      page: (url, file) => latest.current.port.page(url, file),
      remove: (id) => latest.current.port.remove(id),
      clear: () => latest.current.port.clear(),
      submit: () => latest.current.submit(),
      annotations: () => latest.current.port.annotations(),
    });
  }, [threadId]);
}
