import { useThreadMeta } from "@ace/client-react";
import { ForkPoint } from "@ace/protocol";
import {
  currentModelChoice,
  modelLabel,
  providerNames,
  recordedChoice,
  selectionInputs,
  type AttachmentReader,
} from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage } from "@/lib/daemon-command.ts";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useModelChoices } from "@/features/models/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { Composer, type Draft } from "../composer/composer.tsx";
import { ComposerDock } from "../composer/composer-dock.tsx";
import { ContinuationRefused, forkWithDraft } from "../composer/continue-in-thread.ts";
import { runsNow } from "../composer/execution.ts";
import { ParentCrumb } from "../header/thread-crumb.tsx";
import { useShownTitle } from "../lib/shown-title.ts";
import { useThreadSources, type Selection, type ThreadRef } from "../sources/index.ts";
import { ThreadLoading } from "../thread-loading.tsx";
import { ForkModelPicker } from "./fork-model-picker.tsx";
import type { ForkDraftSearch } from "./fork-opener.ts";

/** Desktop widths put the caret in the composer when the fork opens; a phone's keyboard waits. */
const wideEnoughToFocus = () =>
  typeof matchMedia === "function" && matchMedia("(min-width: 768px)").matches;

/**
 * A fork of `threadId` at a turn (`run`) or an answer (`item`), before its first message: a thread of its own with its
 * composer ready. Sending starts the fork with that message (its files and mentions go with it)
 * and opens it in place of this page; leaving creates nothing. The source thread is untouched.
 */
export function ForkDraftView(props: { threadId: string; at: ForkDraftSearch }) {
  const point = useMemo(
    () =>
      ForkPoint.parse(
        props.at.run
          ? { type: "turn", runId: props.at.run }
          : { type: "item", itemId: props.at.item },
      ),
    [props.at.run, props.at.item],
  );
  const meta = useThreadMeta(props.threadId);
  const parentTitle = useShownTitle(props.threadId, meta?.title);
  const title = parentTitle === undefined ? "" : `${parentTitle} (fork)`.slice(0, 256);
  const thread = useMemo<ThreadRef | undefined>(
    () =>
      meta && parentTitle !== undefined
        ? {
            id: props.threadId,
            workspaceId: meta.workspaceId,
            title: parentTitle,
            provider: meta.provider,
          }
        : undefined,
    [props.threadId, meta, parentTitle],
  );
  return (
    <Screen crumb={meta && <ParentCrumb threadId={props.threadId} />} title={title}>
      {thread && meta ? (
        <div
          data-thread-column
          className="relative grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"
        >
          <ForkComposer thread={thread} point={point} title={title} runsNow={runsNow(meta)} />
        </div>
      ) : (
        <ThreadLoading />
      )}
    </Screen>
  );
}

function ForkComposer(props: {
  thread: ThreadRef;
  point: ForkPoint;
  title: string;
  runsNow: Selection;
}) {
  const sources = useThreadSources();
  const navigate = useNavigate();
  const toast = useToast();
  const catalog = useModelCatalog();
  const choices = useModelChoices();
  const [picked, setPicked] = useState<Selection>();
  const selection = picked ?? props.runsNow;
  const [focus] = useState(wideEnoughToFocus);
  const choice = currentModelChoice(choices, selection) ?? recordedChoice(selection);
  const modalities = catalog && selectionInputs(catalog, selection);
  const reader: AttachmentReader = {
    provider: providerNames[selection.provider],
    imageInput: undefined,
    model: selection.model ? modelLabel(selection.model) : undefined,
    modalities,
  };
  const pointKey = props.point.type === "turn" ? props.point.runId : props.point.itemId;
  const submit = async (draft: Draft) => {
    try {
      const threadId = await forkWithDraft({
        actions: sources.actions,
        thread: props.thread,
        point: props.point,
        // The parent's own selection forks natively; only a different pick is sent.
        selection: picked,
        reads: {
          provider: selection.provider,
          model: choice?.model ?? selection.model ?? "",
        },
        modalities,
        draft,
        title: props.title || undefined,
      });
      void navigate({ to: "/t/$threadId", params: { threadId }, replace: true });
      return true;
    } catch (error) {
      toast.error({
        title: "Fork not started",
        description: error instanceof ContinuationRefused ? error.message : failureMessage(error),
      });
      return false;
    }
  };
  return (
    <ComposerDock>
      <Composer
        thread={props.thread}
        draftKey={`fork:${props.thread.id}:${pointKey}`}
        busy={false}
        onSubmit={submit}
        reader={reader}
        autoFocus={focus}
        typeToFocus
        placeholder="Message the fork"
        trailing={<ForkModelPicker selection={selection} onPick={setPicked} disabled={false} />}
      />
    </ComposerDock>
  );
}
