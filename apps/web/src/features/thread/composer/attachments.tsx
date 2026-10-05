import { ClientError } from "@ace/client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ChipAttachment } from "@/components/attachment-chips.tsx";
import { formatBytes, type LocalAttachment } from "@/components/attachment-format.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";

export interface PendingAttachment extends ChipAttachment {
  /** Size in bytes; unknown for a draft restored after a reload. */
  bytes?: number | undefined;
  /** Set once the daemon holds the file. */
  sha256?: string | undefined;
}

/** A file the daemon holds, ready to go with the message. */
export interface ReadyAttachment {
  sha256: string;
  name: string;
}

/** Larger files are refused before uploading; the daemon's own limit is higher. */
export const maxAttachmentBytes = 25_000_000;

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
    new Map<number, Promise<ReadyAttachment | undefined>>(
      restored.map((file, index) => [-1 - index, Promise.resolve(file)]),
    ),
  );
  const files = useRef(new Map<number, File>());
  useEffect(() => {
    // The chips' code, warmed while the composer is up so the first file shows at once.
    void ChipRow.preload();
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);
  const upload = useCallback(
    (key: number, file: File) => {
      const patch = (change: Partial<PendingAttachment>) =>
        setItems((list) => list.map((item) => (item.key === key ? { ...item, ...change } : item)));
      const outcome = sources.context
        .upload(thread, file, (progress) => patch({ progress }))
        .then(
          (attachment) => {
            patch({ state: "ready", progress: 1, sha256: attachment.sha256 });
            files.current.delete(key);
            return { sha256: attachment.sha256, name: file.name };
          },
          (error: unknown) => {
            patch({ state: "failed", error: uploadError(error), retryable: true });
            return undefined;
          },
        );
      outcomes.current.set(key, outcome);
    },
    [sources, thread],
  );
  const add = useCallback(
    (added: Iterable<File>) => {
      for (const file of added) {
        const key = ++next.current;
        const preview =
          file.type.startsWith("image/") && typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(file)
            : undefined;
        if (preview) previews.current.add(preview);
        const tooBig = file.size > maxAttachmentBytes;
        setItems((list) => [
          ...list,
          {
            key,
            name: file.name,
            preview,
            mimeType: file.type || undefined,
            bytes: file.size,
            state: tooBig ? "failed" : "uploading",
            progress: 0,
            ...(tooBig
              ? {
                  error: `Too large: ${formatBytes(file.size)}, the limit is ${formatBytes(maxAttachmentBytes)}`,
                  retryable: false,
                }
              : {}),
          },
        ]);
        if (tooBig) {
          outcomes.current.set(key, Promise.resolve(undefined));
          continue;
        }
        files.current.set(key, file);
        upload(key, file);
      }
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
    }
  };
  const remove = (key: number) => {
    forget([key]);
    setItems((list) => {
      const gone = list.find((item) => item.key === key);
      if (gone?.preview) {
        URL.revokeObjectURL(gone.preview);
        previews.current.delete(gone.preview);
      }
      return list.filter((item) => item.key !== key);
    });
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
    Promise.all(outcomes.current.values()).then((all) => all.filter((file) => file !== undefined));
  /**
   * Take every chip out of the composer for a message that is being sent: the files as a
   * pending bubble shows them (`local`), what `settled()` would give, and `release()`, which
   * frees the image previews once the bubble no longer needs them.
   */
  const handOff = (): {
    local: LocalAttachment[];
    settled: Promise<ReadyAttachment[]>;
    release(): void;
  } => {
    const ready = settled();
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
 * The attachments of the message being written (see `AttachmentChipRow`). `unsupported` is the
 * provider's note for image chips, e.g. "Codex can't read images in this mode; it will get the
 * file path".
 */
export function AttachmentChips(props: {
  items: readonly PendingAttachment[];
  onRemove(key: number): void;
  onRetry?: ((key: number) => void) | undefined;
  unsupported?: string | undefined;
}) {
  if (!props.items.length) return null;
  return (
    // The row's height, held while its code arrives.
    <Suspense fallback={<div aria-hidden className="h-11" />}>
      <ChipRow.Component {...props} />
    </Suspense>
  );
}
