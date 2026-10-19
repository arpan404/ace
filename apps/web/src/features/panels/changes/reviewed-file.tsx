import type { FileDiff } from "@ace/ui-core";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import type { ReviewComposition } from "./compositions.ts";
import { CompositionEditor } from "./composition-editor.tsx";
import type { ReviewDraft } from "./drafts.ts";
import { FileActions } from "./file-actions.tsx";
import { FileDiffBlock, inRange, type LineRange, type LineTarget } from "./file-diff.tsx";
import type { FileView } from "./file-view.ts";
import { DraftCard } from "./line-comment.tsx";

/**
 * What a reviewed file asks of the Changes tab. One object for the tab's life, whose methods
 * reach the tab's latest state: a file's block re-renders only when its own diff, view,
 * comments or open composition change, never because the tab re-rendered around it.
 */
export interface ReviewHandlers {
  setView(path: string, view: FileView): void;
  setViewed(file: FileDiff, viewed: boolean, view: FileView): void;
  comment(file: FileDiff, range: LineRange): void;
  extend(composition: ReviewComposition, file: FileDiff, range: LineRange): void;
  reselect(compositionId: string): void;
  send(key: string): void;
  edit(draft: ReviewDraft): void;
  resolve(key: string, resolved: boolean): void;
  apply(key: string): void;
  discard(key: string): void;
}

/** `handlers` as one stable object; each call runs the version from the latest render. */
export function useReviewHandlers(handlers: ReviewHandlers): ReviewHandlers {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  return useMemo<ReviewHandlers>(
    () => ({
      setView: (...args) => latest.current.setView(...args),
      setViewed: (...args) => latest.current.setViewed(...args),
      comment: (...args) => latest.current.comment(...args),
      extend: (...args) => latest.current.extend(...args),
      reselect: (...args) => latest.current.reselect(...args),
      send: (...args) => latest.current.send(...args),
      edit: (...args) => latest.current.edit(...args),
      resolve: (...args) => latest.current.resolve(...args),
      apply: (...args) => latest.current.apply(...args),
      discard: (...args) => latest.current.discard(...args),
    }),
    [],
  );
}

/** One saved comment, acting through the tab. */
export function DraftView(props: { draft: ReviewDraft; handlers: ReviewHandlers }) {
  const { draft, handlers } = props;
  return (
    <DraftCard
      draft={draft}
      onSend={() => handlers.send(draft.key)}
      onEdit={() => handlers.edit(draft)}
      onResolve={(resolved) => handlers.resolve(draft.key, resolved)}
      onApply={() => handlers.apply(draft.key)}
      onDiscard={() => handlers.discard(draft.key)}
    />
  );
}

/**
 * A changed file under review: its diff with Viewed and the file's actions in the header, each
 * comment under its last line marking the lines it covers, and the comment being written.
 */
export const ReviewedFile = memo(function ReviewedFile(props: {
  id: string;
  threadId: string;
  file: FileDiff;
  view: FileView;
  mode: "unified" | "split";
  wrap: boolean;
  viewed: boolean;
  /** This file's comments. */
  drafts: readonly ReviewDraft[];
  /** The comment being written, when it is on this file at this version. */
  composition: ReviewComposition | undefined;
  handlers: ReviewHandlers;
}) {
  const { file, view, handlers, composition, drafts } = props;
  const writing = composition?.range;
  // A comment shows under its last line and marks every line it covers.
  const at = (target: LineTarget) =>
    drafts.filter(
      (draft) => draft.side === target.side && (draft.end ?? draft.line) === target.line,
    );
  return (
    <FileDiffBlock
      id={props.id}
      file={file}
      view={view}
      onView={(next) => handlers.setView(file.path, next)}
      mode={props.mode}
      wrap={props.wrap}
      viewed={props.viewed}
      actions={
        <FileActions
          threadId={props.threadId}
          path={file.path}
          viewed={props.viewed}
          open={view.open}
          onOpen={(open) => handlers.setView(file.path, { ...view, open })}
          onViewed={(next) => handlers.setViewed(file, next, view)}
        />
      }
      highlighted={(target) =>
        inRange(writing, target) ||
        drafts.some((draft) =>
          inRange({ side: draft.side, start: draft.line, end: draft.end ?? draft.line }, target),
        )
      }
      selection={writing}
      onComment={(range) => handlers.comment(file, range)}
      onExtend={(range) => {
        if (composition) handlers.extend(composition, file, range);
      }}
      renderAnnotation={(target) => {
        if (composition && writing && writing.side === target.side && writing.end === target.line)
          // The line's other saved comments stay in reach; the one being edited is the editor.
          return (
            <>
              {at(target)
                .filter((draft) => draft.key !== composition.key)
                .map((draft) => (
                  <DraftView key={draft.key} draft={draft} handlers={handlers} />
                ))}
              <CompositionEditor
                key={composition.id}
                composition={composition}
                onReselect={() => handlers.reselect(composition.id)}
              />
            </>
          );
        return at(target).map((draft) => (
          <DraftView key={draft.key} draft={draft} handlers={handlers} />
        ));
      }}
    />
  );
});
