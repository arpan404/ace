import type { PreviewSuggestion as WireSuggestion } from "@ace/protocol";
import type { PreviewSuggestion } from "../sources.ts";

/*
 * Detected dev servers per thread, as the daemon reports them in a `preview.request` list that
 * asked for them and in `preview.suggestions` pushes. Only threads the caller still keeps are
 * stored; a source this client doesn't know reads as a found listener.
 */

const none: readonly PreviewSuggestion[] = [];

export function suggestionView(wire: WireSuggestion): PreviewSuggestion {
  return {
    port: wire.port,
    url: wire.url,
    title: wire.title,
    iconUrl: wire.iconUrl,
    source: wire.source === "terminal" ? "terminal" : "listener",
  };
}

export class SuggestionStore {
  private readonly threads = new Map<string, readonly PreviewSuggestion[]>();

  get(threadId: string): readonly PreviewSuggestion[] {
    return this.threads.get(threadId) ?? none;
  }

  /** Replace a thread's list; false when nothing visible changed. */
  set(threadId: string, wire: readonly WireSuggestion[]): boolean {
    const next = wire.map(suggestionView);
    const previous = this.threads.get(threadId);
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return false;
    this.threads.set(threadId, next);
    return true;
  }

  delete(threadId: string): void {
    this.threads.delete(threadId);
  }

  clear(): void {
    this.threads.clear();
  }
}
