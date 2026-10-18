import type { CatalogMention } from "@ace/protocol";
import { Suspense, type RefObject } from "react";
import type { ThreadRef } from "../sources/index.ts";
import {
  DeferredCommandArguments,
  DeferredSuggestionList,
  DeferredThreadAttachments,
} from "./deferred-parts.tsx";
import type { Trigger } from "./draft.ts";
import type { Suggestion, Suggestions } from "./suggestions.tsx";

/** What floats over the composer: suggestions, the thread's attachments, a command's arguments. */
export function ComposerOverlays(props: {
  thread: ThreadRef;
  anchor: RefObject<HTMLElement | null>;
  listId: string;
  suggestions: Suggestions;
  adding: boolean;
  active: number;
  onHover(index: number): void;
  onPick(item: Suggestion): void;
  onDismiss(): void;
  showAttachments: boolean;
  onCloseAttachments(): void;
  argumentsFor: { item: Suggestion; trigger: Trigger } | undefined;
  onCloseArguments(): void;
  onArguments(
    item: Suggestion,
    trigger: Trigger,
    values: NonNullable<CatalogMention["values"]>,
  ): void;
}) {
  const asking = props.argumentsFor;
  return (
    <>
      {props.suggestions.state !== "closed" && (
        <Suspense fallback={null}>
          <DeferredSuggestionList.Component
            adding={props.adding}
            id={props.listId}
            anchor={props.anchor}
            onDismiss={props.onDismiss}
            suggestions={props.suggestions}
            active={props.active}
            onHover={props.onHover}
            onPick={props.onPick}
          />
        </Suspense>
      )}
      {props.showAttachments && (
        <Suspense fallback={null}>
          <DeferredThreadAttachments.Component
            thread={props.thread}
            onClose={props.onCloseAttachments}
          />
        </Suspense>
      )}
      {asking?.item.entry && (
        <Suspense fallback={null}>
          <DeferredCommandArguments.Component
            entry={asking.item.entry}
            onClose={props.onCloseArguments}
            onAccept={(values) => props.onArguments(asking.item, asking.trigger, values)}
          />
        </Suspense>
      )}
    </>
  );
}
