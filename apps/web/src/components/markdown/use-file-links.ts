import type { ClientApi } from "@ace/client";
import { codeFileReference } from "@ace/ui-core/file-references";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ScopeWorkspace, WorkspaceActions } from "@/lib/workspace/index.ts";
import {
  fileMentionLabel,
  fileMentionTab,
  resolveFileMention,
  type MentionResolution,
} from "../file-reference.ts";
import {
  fileMentions,
  linkFileMentions,
  unlinkFileCode,
  type FileMention,
  type Resolved,
} from "./file-links.ts";

/**
 * File mentions in one thread answer: while it streams markit's file references read as plain
 * code; once it is settled its mentions are looked up in the thread's checkout, the confirmed
 * ones linked and the rest made plain. An absolute path links even where the checkout lacks it
 * (outside the project, or ignored): it opens beside the thread as a file the answer names.
 * `open` follows a mention, looking it up first if its answer hasn't come yet; a relative name
 * the checkout doesn't have opens nothing. With no workspace (an answer drawn outside the shell)
 * nothing links: there is no panel to open in.
 */
export function useFileLinks(input: {
  client: ClientApi;
  threadId: string;
  /** The answer drawn, whose absolute paths open even outside the checkout. */
  itemId: string | undefined;
  root: string | undefined;
  workspace: { actions: WorkspaceActions; read: () => ScopeWorkspace } | undefined;
}) {
  const { client, threadId, itemId, root, workspace } = input;
  const answers = useRef(
    new Map<string, { mention: FileMention; resolution: MentionResolution }>(),
  );
  const lookups = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => lookups.current?.abort(), []);

  const drawn = useCallback(
    (element: HTMLElement, finalized: boolean) => {
      if (!finalized || !workspace) return unlinkFileCode(element, () => true);
      const known = (text: string) => answers.current.get(text)?.resolution;
      const confirmed = () => {
        const found = new Map<string, Resolved>();
        for (const [text, { resolution }] of answers.current)
          if (resolution.kind !== "none") found.set(text, resolution);
        return found;
      };
      const label = (mention: FileMention, resolution: Resolved) =>
        fileMentionLabel(mention.text, mention.reference, resolution);
      const settle = () => {
        unlinkFileCode(element, (text) => known(text)?.kind === "none");
        linkFileMentions(element, confirmed(), label);
      };
      settle();
      const unknown = fileMentions(element).filter((mention) => !known(mention.text));
      if (unknown.length === 0) return;
      lookups.current?.abort();
      const controller = new AbortController();
      lookups.current = controller;
      const thread = { threadId, root, itemId };
      void Promise.all(
        unknown.map(async (mention) => {
          const resolution = await resolveFileMention(
            client,
            thread,
            mention.reference,
            controller.signal,
          ).catch((): MentionResolution => ({ kind: "none" }));
          if (!controller.signal.aborted)
            answers.current.set(mention.text, { mention, resolution });
        }),
      ).then(() => {
        if (!controller.signal.aborted && element.isConnected) settle();
      });
    },
    [client, threadId, itemId, root, workspace],
  );

  const open = useCallback(
    (target: string) => {
      if (!workspace) return;
      const follow = (mention: FileMention, resolution: MentionResolution) => {
        if (resolution.kind !== "none")
          workspace.actions.open(fileMentionTab(workspace.read(), mention.reference, resolution));
      };
      const known = answers.current.get(target);
      if (known) return follow(known.mention, known.resolution);
      const reference = codeFileReference(target);
      if (!reference) return;
      const mention = { text: target, reference };
      void resolveFileMention(
        client,
        { threadId, root, itemId },
        reference,
        new AbortController().signal,
      )
        .then((resolution) => follow(mention, resolution))
        .catch(() => {});
    },
    [client, threadId, itemId, root, workspace],
  );

  return useMemo(() => ({ drawn, open }), [drawn, open]);
}
