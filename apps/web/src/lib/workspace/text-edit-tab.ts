import { createContext } from "react";
import type { OpenRequest } from "./model.ts";

/*
 * A side panel tab editing text that lives somewhere else (a long paste in the composer, not
 * sent yet). The tab only exists while the edit does: its text is held by whoever opened it,
 * reached through `TextEdits`, so the tab is never stored and never comes back after a reload.
 */

export const textEditTabKind = "text-edit";

/** Kinds whose tabs live only as long as the page: the store never writes them. */
export const transientTabKinds: ReadonlySet<string> = new Set([textEditTabKind]);

/** The tab for one edit (`id`: the edit's own, stable while the text it edits is renamed). */
export function textEditTab(id: string, title: string): OpenRequest {
  return { kind: textEditTabKind, id, title };
}

/** One text being edited in a tab: what it started as, what was typed since, and where typing goes. */
export interface TextEditSession {
  /** The text as it was opened. */
  readonly file: File;
  /** What was typed since it opened, if anything. */
  typed(): string | undefined;
  type(text: string): void;
}

/**
 * The edits open on one screen, by tab id: the composer starts and ends them, the tab's view
 * reads and types into them.
 */
export class TextEdits {
  private readonly sessions = new Map<string, TextEditSession>();
  private readonly listeners = new Set<() => void>();

  start(id: string, session: TextEditSession): void {
    this.sessions.set(id, session);
    this.emit();
  }

  end(id: string): void {
    if (this.sessions.delete(id)) this.emit();
  }

  get(id: string): TextEditSession | undefined {
    return this.sessions.get(id);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

/** The screen's edits; absent where no side panel can hold them (a draft's New thread screen). */
export const TextEditsContext = createContext<TextEdits | undefined>(undefined);
