import type { ClientApi } from "@ace/client";
import type { ContentPart, Item, TextSource } from "@ace/protocol";
import { useClient } from "@ace/client-react";
import { useEffect, useMemo, useSyncExternalStore } from "react";

const maxAnswerBytes = 8 * 1024 * 1024;
type TextPart = Extract<ContentPart, { type: "text" }>;
const empty: readonly TextPart[] = [];
const isPreview = (part: TextPart) =>
  part.source !== undefined && part.source.bytes > part.text.length * 2;

interface Entry {
  text: string;
  /** Characters read from the authoritative source, independent of the SDK's clipped preview. */
  loaded: number;
  source: TextSource | undefined;
}
interface Reading {
  text: string;
  partial: boolean;
  status: "loading" | "ready" | "failed";
  retryable: boolean;
  problem?: string;
}

/**
 * One displayed item's source reads. Descriptors can advance while a read is in flight: keep
 * the newest target, finish the bounded read, then request only its missing suffix. Neither
 * another item's completion nor an arriving delta cancels progress already being made.
 */
class TextReader {
  private entries: Entry[] = [];
  private snapshot: Reading | undefined;
  private listeners = new Set<() => void>();
  private controller: AbortController | undefined;
  private problem: string | undefined;
  private oversized = false;
  private client: ClientApi;

  constructor(client: ClientApi) {
    this.client = client;
  }
  read = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  stop = () => {
    this.controller?.abort();
    this.controller = undefined;
  };
  retry = () => {
    if (this.oversized) return;
    this.problem = undefined;
    this.publish();
    this.pump();
  };
  want(parts: readonly TextPart[]): void {
    const previous = this.entries;
    this.entries = parts.map((part, index) => {
      const old = previous[index];
      if (
        old?.source &&
        part.source &&
        old.source.streamId === part.source.streamId &&
        part.source.bytes >= old.loaded * 2
      ) {
        old.source = part.source;
        if (!old.loaded) old.text = part.text;
        return old;
      }
      return {
        text: part.text,
        loaded: isPreview(part) ? 0 : part.text.length,
        source: part.source,
      };
    });
    if (previous.some((entry, index) => this.entries[index] !== entry)) {
      this.stop();
      this.problem = undefined;
    }
    this.oversized =
      parts.reduce(
        (total, part) => total + Math.max(part.text.length * 2, part.source?.bytes ?? 0),
        0,
      ) > maxAnswerBytes;
    if (this.oversized) {
      this.stop();
      this.problem = "This text is too large to display here. You can still copy the preview.";
    }
    this.publish();
    this.pump();
  }
  private publish(): void {
    const partial = this.entries.some(
      (entry) => entry.source && entry.loaded * 2 < entry.source.bytes,
    );
    this.snapshot = {
      text: this.entries.map((entry) => entry.text).join(""),
      partial,
      status: this.problem ? "failed" : partial ? "loading" : "ready",
      retryable: !!this.problem && !this.oversized,
      ...(this.problem ? { problem: this.problem } : {}),
    };
    for (const listener of this.listeners) listener();
  }
  private pump(): void {
    if (this.controller || this.problem || this.oversized) return;
    const pending = this.entries.find(
      (entry) => entry.source && entry.loaded * 2 < entry.source.bytes,
    );
    if (!pending?.source) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.hydrate(controller).finally(() => {
      if (this.controller !== controller) return;
      this.controller = undefined;
      this.pump();
    });
  }
  private async hydrate(controller: AbortController): Promise<void> {
    try {
      for (const entry of this.entries) {
        const source = entry.source;
        if (!source || entry.loaded * 2 >= source.bytes) continue;
        for await (const chunk of this.client.text(source, {
          offset: entry.loaded * 2,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) return;
          entry.text = entry.loaded ? entry.text + chunk : chunk;
          entry.loaded += chunk.length;
          this.publish();
        }
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      this.problem = error instanceof Error ? error.message : "Couldn't load the full text.";
      this.publish();
    }
  }
}

/** Source-backed answers and thoughts hydrate automatically, including during an active turn. */
export function useAnswerText(item: Item | undefined) {
  const client = useClient();
  const parts = useMemo((): readonly TextPart[] => {
    if (item?.type === "message")
      return item.parts.filter((part): part is TextPart => part.type === "text");
    if (item?.type === "reasoning")
      return [{ type: "text", text: item.text, ...(item.source ? { source: item.source } : {}) }];
    return empty;
  }, [item]);
  const { reader } = useMemo(
    () => ({ id: item?.id, reader: new TextReader(client) }),
    [client, item?.id],
  );
  const state = useSyncExternalStore(reader.subscribe, reader.read, reader.read);
  const truncated = parts.some(isPreview);
  useEffect(() => {
    if (truncated) reader.want(parts);
    else reader.stop();
  }, [reader, parts, truncated]);
  useEffect(() => reader.stop, [reader]);
  return {
    ...((truncated ? state : undefined) ?? {
      text: parts.map((part) => part.text).join(""),
      partial: truncated,
      status: truncated ? "loading" : "ready",
      retryable: false,
      problem: undefined,
    }),
    truncated,
    load: reader.retry,
  };
}
