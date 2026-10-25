import { createContext, useContext } from "react";

/** Someone `@` can mention. */
export type { CompletionPerson } from "@ace/ui-core";
import type { CompletionPerson } from "@ace/ui-core";

/** An issue or pull request `#` can point at. */
export interface CompletionReference {
  number: number;
  title: string;
  kind: "issue" | "pr";
  state: "open" | "draft" | "closed" | "merged";
}

/**
 * Where an editor's `@` and `#` suggestions come from: the page it is on knows the repository
 * and who takes part. Either half may be missing; a search that fails shows nothing.
 */
export interface MarkdownCompletions {
  people?(query: string, signal: AbortSignal): Promise<readonly CompletionPerson[]>;
  references?(query: string, signal: AbortSignal): Promise<readonly CompletionReference[]>;
}

const Completions = createContext<MarkdownCompletions | undefined>(undefined);

/** Every Markdown editor inside completes `@` and `#` from `value`. */
export const MarkdownCompletionsProvider = Completions.Provider;

export function useMarkdownCompletions(): MarkdownCompletions | undefined {
  return useContext(Completions);
}
