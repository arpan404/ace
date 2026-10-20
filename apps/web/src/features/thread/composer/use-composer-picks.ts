import { useClient } from "@ace/client-react";
import { ThreadId, type CatalogMention, type Mention } from "@ace/protocol";
import { editComposerTokens, type ComposerToken } from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, type RefObject } from "react";
import {
  receiveComposerMentions,
  receiveComposerTabs,
  receiveComposerText,
  type ComposerTab,
} from "@/lib/composer-insert.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadRef } from "../sources/index.ts";
import { useForkOpener } from "../transitions/fork-opener.ts";
import type { AddHandle } from "./add-button.tsx";
import { accept, insertAt, type Trigger } from "./draft.ts";
import type { Suggestion } from "./suggestions.tsx";

/** A change to the message from the composer itself, with the chips it leaves. */
export type ComposerEdit = { text: string; caret: number; tokens?: readonly ComposerToken[] };

const tooManyReferences = "This message has enough references. Remove one before adding another.";
/** At most this many browser tabs mentioned in one message: each carries a snapshot and image. */
const tabMentionLimit = 4;

/**
 * What picking a suggestion does: a file, thread or catalog entry becomes a chip, an action
 * runs, a prompt with parameters asks for them first. Mentions sent from elsewhere on the
 * screen (a file's "Mention in composer") land at the caret.
 */
export function useComposerPicks(args: {
  thread: ThreadRef;
  text: string;
  tokens: readonly ComposerToken[];
  caret: number;
  trigger: Trigger | undefined;
  adding: boolean;
  edit(next: ComposerEdit): void;
  rememberMention(path: string): void;
  setAdding(adding: boolean): void;
  setDismissed(start: number | undefined): void;
  setNotice(notice: string | undefined): void;
  showAttachments(): void;
  askArguments(item: Suggestion, trigger: Trigger): void;
  closeArguments(): void;
  addMenu: RefObject<AddHandle | null>;
  box: RefObject<HTMLDivElement | null>;
  onPlan?: (() => void) | undefined;
}) {
  "use no memo";
  const client = useClient();
  const navigate = useNavigate();
  const workspace = useWorkspaceActions(args.thread.id);
  const fork = useForkOpener();
  const { text, tokens, edit } = args;
  const addToken = (
    item: Suggestion,
    at: Trigger,
    values?: NonNullable<CatalogMention["values"]>,
  ) => {
    const label = item.entry || item.threadId || item.tab ? item.label : `@${item.label}`;
    const next = accept(text, at, label);
    const catalog: CatalogMention | undefined = item.entry
      ? {
          type: "mention",
          entryId: item.entry.id,
          name: item.entry.name,
          title: label,
          kind: item.entry.kind,
          ...(item.entry.icon ? { icon: item.entry.icon } : {}),
          arguments: "",
          ...(values ? { values } : {}),
        }
      : undefined;
    const token: ComposerToken = {
      start: at.start,
      end: at.start + label.length,
      label,
      ...(catalog ? { catalog } : {}),
      ...(item.path ? { file: { path: item.path } } : {}),
      ...(item.threadId
        ? {
            thread: {
              type: "thread_ref",
              threadId: ThreadId.parse(item.threadId),
              budgetBytes: 4096,
            },
          }
        : {}),
      ...(item.tab
        ? {
            browserTab: {
              type: "browser_tab",
              tabId: item.tab.tabId,
              url: item.tab.url,
              title: item.tab.title,
            },
          }
        : {}),
    };
    if (item.path) args.rememberMention(item.path);
    edit({
      ...next,
      tokens: [...editComposerTokens(text, next.text, tokens), token].toSorted(
        (a, b) => a.start - b.start,
      ),
    });
    args.closeArguments();
  };
  const runAction = (action: string, at: Trigger) => {
    edit(accept(text, at, ""));
    args.setDismissed(at.start);
    const adding = args.adding;
    void import("./actions.ts")
      .then(({ composerAction }) =>
        composerAction(action, {
          client,
          thread: args.thread,
          attach: () => args.addMenu.current?.attach(),
          files: () => {
            const next = adding ? insertAt(text, at.start, "@ ") : accept(text, at, "@");
            edit({ ...next, caret: adding ? next.caret - 1 : at.start + 1 });
            args.setDismissed(undefined);
          },
          project: () =>
            void navigate({ to: "/new", search: { project: args.thread.workspaceId } }),
          model: () =>
            args.box.current
              ?.querySelector<HTMLButtonElement>('button[aria-label^="Model:"]')
              ?.click(),
          review: () => workspace.open({ kind: "changes", id: "changes" }),
          fork: (point) => {
            if (fork) fork(point);
          },
          insert: (value) => edit(accept(text, at, value)),
          plan: args.onPlan,
        }),
      )
      .catch((error) =>
        args.setNotice(
          error instanceof Error
            ? error.message
            : "Couldn't use this action. Try again from the thread's menu.",
        ),
      );
  };
  const pick = (item: Suggestion) => {
    args.setAdding(false);
    const trigger = args.trigger;
    if (!trigger) return;
    if (
      tokens.length >= 64 ||
      (item.threadId && tokens.filter((token) => token.thread).length >= 8) ||
      (item.tab && tokens.filter((token) => token.browserTab).length >= tabMentionLimit)
    ) {
      args.setNotice(tooManyReferences);
      return;
    }
    const invocation = item.entry?.invocation;
    if (invocation?.type === "unavailable") {
      args.setNotice("This item isn't available for this provider. Choose another item.");
      return;
    }
    if (invocation?.type === "action") {
      if (invocation.action === "attachments") {
        args.showAttachments();
        edit(accept(text, trigger, ""));
        return;
      }
      runAction(invocation.action, trigger);
      return;
    }
    if (invocation?.type === "prompt" && Object.keys(invocation.parameters ?? {}).length) {
      args.askArguments(item, trigger);
      args.setDismissed(trigger.start);
      return;
    }
    addToken(item, trigger);
  };
  const insertMention = useEffectEvent((file: Mention) => {
    if (tokens.length >= 64) {
      args.setNotice(tooManyReferences);
      return;
    }
    const label = `@${file.path}${file.lines ? `:${file.lines.start}-${file.lines.end}` : ""}`;
    const next = insertAt(text, args.caret, `${label} `);
    const start = next.caret - label.length - 1;
    edit({
      ...next,
      tokens: [
        ...editComposerTokens(text, next.text, tokens),
        { start, end: start + label.length, label, file },
      ].toSorted((a, b) => a.start - b.start),
    });
    args.rememberMention(file.path);
  });
  // "Ask agent about this page" from the Browser: the tab, mentioned where the caret is.
  const insertTab = useEffectEvent((tab: ComposerTab) => {
    if (
      tokens.length >= 64 ||
      tokens.filter((token) => token.browserTab).length >= tabMentionLimit
    ) {
      args.setNotice(tooManyReferences);
      return;
    }
    const label = tab.title || tab.url;
    const next = insertAt(text, args.caret, `${label} `);
    const start = next.caret - label.length - 1;
    edit({
      ...next,
      tokens: [
        ...editComposerTokens(text, next.text, tokens),
        {
          start,
          end: start + label.length,
          label,
          browserTab: { type: "browser_tab" as const, ...tab },
        },
      ].toSorted((a, b) => a.start - b.start),
    });
  });
  // "Fix with agent" from the PR panel: its request, at the caret, for the person to send.
  const insertText = useEffectEvent((value: string) => {
    const spaced = text && !/\s$/.test(text.slice(0, args.caret)) ? `\n\n${value}` : value;
    const next = insertAt(text, args.caret, spaced);
    edit({ ...next, tokens: editComposerTokens(text, next.text, tokens) });
  });
  const threadId = args.thread.id;
  const draft = args.thread.draft;
  useEffect(() => {
    if (draft) return;
    const stops = [
      receiveComposerMentions(threadId, (file) => insertMention(file)),
      receiveComposerTabs(threadId, (tab) => insertTab(tab)),
      receiveComposerText(threadId, (value) => insertText(value)),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [threadId, draft]);
  return { addToken, pick };
}
