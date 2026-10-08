import { ClientError } from "@ace/client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ChipAttachment } from "@/components/attachment-chips.tsx";
import type { LocalAttachment } from "@/components/attachment-format.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";

export interface PendingAttachment extends ChipAttachment {
  /** Size in bytes; unknown for a draft restored after a reload. */
  bytes?: number | undefined;
}

/** A file the daemon holds, ready to go with the message. */
export interface ReadyAttachment {
  sha256: string;
  name: string;
}

/** How one file's upload ended: the daemon holds it, or why not, in words. */
export type Outcome = ReadyAttachment | { error: string };
const lost: Outcome = { error: "it was removed" };

/** Client preflight matches the daemon defaults; the daemon enforces configured limits. */
export const maxAttachmentBytes = 512 * 1024 * 1024;
/** All of one message's files together (the daemon's default). */
export const maxMessageBytes = 1024 * 1024 * 1024;
/** Files one message carries (`MessageContext.attachments`). */
export const maxAttachmentsPerMessage = 64;

// The limits above in words (binary units, as the daemon sets them).
const tooLarge = "Too large: files can be up to 512 MB each";
const tooMuch = "Too much for one message: files can add up to 1 GB";

/** What the hook knows of a chip: its file, whether its bytes count, and what it is once held. */
interface Known {
  file?: File | undefined;
  /** Bytes counted toward the message's total; 0 for a file refused before uploading. */
  bytes: number;
  /** The daemon's hash and the name, once it holds the file. */
  id?: string | undefined;
}

const ChipRow = deferredComponent(() =>
  import("@/components/attachment-chips.tsx").then((module) => module.AttachmentChipRow),
);

/** Why an upload failed, in words the person can act on. */
function uploadError(error: unknown): string {
  if (
    error instanceof ClientError &&
    ["offline", "timeout", "stale", "aborted"].includes(error.code)
  )
    return "Connection lost";
  return error instanceof Error && error.message ? error.message : "The upload failed";
}

/**
 * Files and images added to the next message, uploaded into the thread's context right away.
 * `restored` are uploads the daemon already holds, from a draft kept across a reload.
 */
export function useAttachments(
  thread: ThreadRef,
  restored: readonly { sha256: string; name: string }[] = [],
) {
  const sources = useThreadSources();
  const toast = useToast();
  const removed = useRef(new Set<number>());
  const inFlight = useRef(new Set<number>());
  const [items, setItems] = useState<PendingAttachment[]>(() =>
    restored.map((file, index) => ({
      key: -1 - index,
      name: file.name,
      state: "ready",
      progress: 1,
      sha256: file.sha256,
    })),
  );
  const next = useRef(0);
  const previews = useRef(new Set<string>());
  // Each chip's outcome, kept for `settled()`, and the file itself, kept for Retry.
  const outcomes = useRef(
    new Map<number, Promise<Outcome>>(
      restored.map((file, index) => [-1 - index, Promise.resolve(file)]),
    ),
  );
  const files = useRef(new Map<number, File>());
  const known = useRef(
    new Map<number, Known>(
      restored.map((file, index) => [-1 - index, { bytes: 0, id: `${file.sha256}\0${file.name}` }]),
    ),
  );
  useEffect(() => {
    // The chips' code, warmed while the composer is up so the first file shows at once.
    void ChipRow.preload();
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);
  /** Take one chip away, its preview and what was kept for it included. */
  const drop = useCallback((key: number) => {
    outcomes.current.delete(key);
    files.current.delete(key);
    known.current.delete(key);
    setItems((list) => {
      const gone = list.find((item) => item.key === key);
      if (gone?.preview) {
        URL.revokeObjectURL(gone.preview);
        previews.current.delete(gone.preview);
      }
      return list.filter((item) => item.key !== key);
    });
  }, []);
  useEffect(
    () =>
      sources.context.onReleased((owner, hash) => {
        if (owner.id !== thread.id || owner.draft !== thread.draft) return;
        for (const [key, held] of known.current) if (held.id?.startsWith(`${hash}\0`)) drop(key);
      }),
    [sources, thread.id, thread.draft, drop],
  );
  const upload = useCallback(
    (key: number, file: File) => {
      inFlight.current.add(key);
      const patch = (change: Partial<PendingAttachment>) =>
        setItems((list) => list.map((item) => (item.key === key ? { ...item, ...change } : item)));
      const outcome = sources.context
        .upload(thread, file, (progress) => patch({ progress }))
        .then(
          (attachment) => {
            inFlight.current.delete(key);
            files.current.delete(key);
            const ready = { sha256: attachment.sha256, name: file.name };
            if (removed.current.delete(key)) {
              if (
                ![...known.current.values()].some((held) =>
                  held.id?.startsWith(`${attachment.sha256}\0`),
                )
              ) {
                void sources.context.release(thread, attachment.sha256).catch(() =>
                  toast.error({
                    title: "Couldn't remove the attachment",
                    description: "Open Attachments from the thread menu and try removing it again.",
                  }),
                );
              }
              return lost;
            }
            // The same bytes under the same name are already attached: one chip is enough.
            const id = `${attachment.sha256}\0${file.name}`;
            const twin = [...known.current].some(
              ([other, held]) => other !== key && held.id === id,
            );
            if (twin) {
              drop(key);
              return ready;
            }
            const held = known.current.get(key);
            if (held) held.id = id;
            // The daemon's own reading of the type, which the browser may not have known.
            patch({
              state: "ready",
              progress: 1,
              sha256: attachment.sha256,
              mimeType: attachment.mimeType,
              kind: attachment.kind,
            });
            return ready;
          },
          (error: unknown): Outcome => {
            inFlight.current.delete(key);
            removed.current.delete(key);
            const reason = uploadError(error);
            patch({ state: "failed", error: reason, retryable: true });
            return { error: reason };
          },
        );
      outcomes.current.set(key, outcome);
    },
    [sources, thread, drop, toast],
  );
  /**
   * Attach files: each gets its chip and starts uploading. A file already attached (same name,
   * size and date) is skipped; one over the per-file or per-message size limit gets a chip that
   * says so. Returns how many didn't fit the message's file count and were left out.
   */
  const add = useCallback(
    (added: Iterable<File>): number => {
      let left = 0;
      for (const file of added) {
        const held = [...known.current.values()];
        if (
          held.some(
            ({ file: other }) =>
              other?.name === file.name &&
              other.size === file.size &&
              other.lastModified === file.lastModified,
          )
        )
          continue;
        if (held.length >= maxAttachmentsPerMessage) {
          left++;
          continue;
        }
        const key = ++next.current;
        const preview =
          file.type.startsWith("image/") && typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(file)
            : undefined;
        if (preview) previews.current.add(preview);
        const total = held.reduce((sum, { bytes }) => sum + bytes, 0);
        const error =
          file.size > maxAttachmentBytes
            ? tooLarge
            : total + file.size > maxMessageBytes
              ? tooMuch
              : undefined;
        known.current.set(key, { file, bytes: error ? 0 : file.size });
        setItems((list) => [
          ...list,
          {
            key,
            name: file.name,
            preview,
            file,
            mimeType: file.type || undefined,
            bytes: file.size,
            state: error ? "failed" : "uploading",
            progress: 0,
            ...(error ? { error, retryable: false } : {}),
          },
        ]);
        if (error) {
          outcomes.current.set(key, Promise.resolve({ error }));
          continue;
        }
        files.current.set(key, file);
        upload(key, file);
      }
      return left;
    },
    [upload],
  );
  /** Upload a failed file again. */
  const retry = (key: number) => {
    const file = files.current.get(key);
    if (!file) return;
    setItems((list) =>
      list.map((item) =>
        item.key === key
          ? { ...item, state: "uploading", progress: 0, error: undefined, retryable: undefined }
          : item,
      ),
    );
    upload(key, file);
  };
  const forget = (keys: Iterable<number>) => {
    for (const key of keys) {
      outcomes.current.delete(key);
      files.current.delete(key);
      known.current.delete(key);
    }
  };
  const remove = (key: number) => {
    const hash = known.current.get(key)?.id?.split("\0")[0];
    if (!hash) {
      if (inFlight.current.has(key)) removed.current.add(key);
      drop(key);
      return;
    }
    if (
      [...known.current].some(([other, held]) => other !== key && held.id?.startsWith(`${hash}\0`))
    ) {
      drop(key);
      return;
    }
    void sources.context.release(thread, hash).then(
      () => drop(key),
      () =>
        toast.error({
          title: "Couldn't remove the attachment",
          description: "Check the connection and try again.",
        }),
    );
  };
  const clear = () => {
    for (const url of previews.current) URL.revokeObjectURL(url);
    previews.current.clear();
    forget([...outcomes.current.keys()]);
    setItems([]);
  };
  /**
   * The files attached now, once none of them is still uploading: those the daemon holds, in
   * order. Failed ones are left out. Removing or clearing chips afterwards doesn't change it.
   */
  const settled = (): Promise<ReadyAttachment[]> =>
    Promise.all(outcomes.current.values()).then((all) => {
      const seen = new Set<string>();
      return all.flatMap((file) =>
        "sha256" in file && !seen.has(file.sha256) && seen.add(file.sha256) ? [file] : [],
      );
    });
  /**
   * Take every chip out of the composer for a message that is being sent: the files as a
   * pending bubble shows them (`local`), what `settled()` would give, each file's own outcome
   * and the file itself (`outcomes`, `files`, in `local`'s order, for a message held while they
   * upload), and `release()`, which frees the image previews once nothing shows them.
   */
  const handOff = (): {
    local: LocalAttachment[];
    settled: Promise<ReadyAttachment[]>;
    outcomes: Promise<Outcome[]>;
    files: (File | undefined)[];
    release(): void;
  } => {
    const ready = settled();
    const each = Promise.all(
      items.map((item) => outcomes.current.get(item.key) ?? Promise.resolve(lost)),
    );
    const held = items.map((item) => files.current.get(item.key));
    const urls = items.flatMap((item) => (item.preview ? [item.preview] : []));
    for (const url of urls) previews.current.delete(url);
    const local = items.map((item) => ({
      name: item.name,
      mimeType: item.mimeType ?? "application/octet-stream",
      bytes: item.bytes ?? 0,
      previewUrl: item.preview,
    }));
    forget([...outcomes.current.keys()]);
    setItems([]);
    return {
      local,
      settled: ready,
      outcomes: each,
      files: held,
      release: () => {
        for (const url of urls) URL.revokeObjectURL(url);
      },
    };
  };
  const ready = items.flatMap((item) =>
    item.state === "ready" && item.sha256 ? [{ sha256: item.sha256, name: item.name }] : [],
  );
  return {
    items,
    add,
    remove,
    retry,
    clear,
    settled,
    handOff,
    uploading: items.some((item) => item.state === "uploading"),
    ready,
  };
}

/** Warm the chips' code while the browser is idle. */
export const preloadAttachmentChips = ChipRow.preload;

/**
 * The attachments of the message being written, including upload progress and failures.
 */
export function AttachmentChips(props: {
  items: readonly PendingAttachment[];
  onRemove(key: number): void;
  onRetry?: ((key: number) => void) | undefined;
  /** The thread the files go to, for previewing a restored draft's files; none for a draft. */
  threadId?: string | undefined;
}) {
  if (!props.items.length) return null;
  return (
    // The row's height, held while its code arrives.
    <Suspense fallback={<div aria-hidden className="h-11" />}>
      <ChipRow.Component {...props} />
    </Suspense>
  );
}
