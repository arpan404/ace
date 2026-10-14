import { gitFailureText } from "../lib/git-failure.ts";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useConnectionState } from "@ace/client-react";
import type {
  SourceControlContext,
  SourceControlDraft,
  SourceControlSelection,
} from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useUtilityModel } from "@/lib/utility-model.ts";

/**
 * Requests are event-driven: Draft, and with `auto` (and the auto-draft setting on) one draft as the form opens (and
 * again when its files change, until the person edits the text), applied straight into the
 * fields. Reconnects and edits never request another draft, and a draft that lands after the
 * person typed is only offered, never applied.
 */
export function DraftWriter(props: {
  thread: ThreadRef;
  selection: SourceControlSelection | undefined;
  textRevision: number;
  disabled: boolean;
  /** Draft as soon as there is a selection, and apply the result while the text is untouched. */
  auto?: boolean;
  /** The person has typed in the fields: drafts stop applying themselves. */
  edited?: boolean;
  onApply(draft: SourceControlDraft, context: SourceControlContext): void;
}) {
  const thread = useMemo(
    () => ({
      id: props.thread.id,
      workspaceId: props.thread.workspaceId,
      title: props.thread.title,
    }),
    [props.thread.id, props.thread.workspaceId, props.thread.title],
  );
  const workspace = useThreadSources().workspace;
  const connection = useConnectionState();
  const utility = useUtilityModel();
  const [autoDraft] = useDaemonSetting("generation.autoDraftCommits");
  // Drafting on open is the person's setting; with it off, only Draft asks.
  const draftOnOpen = props.auto === true && autoDraft !== false && utility.model !== undefined;
  const [preference, setPreference] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [proposal, setProposal] = useState<{
    draft: SourceControlDraft;
    context: SourceControlContext;
    selection: string;
    textRevision: number;
    applied?: boolean;
  }>();
  const active = useRef<{ id: string; selection: string; controller: AbortController } | undefined>(
    undefined,
  );
  const selectionKey = JSON.stringify(props.selection);
  const cancel = () => {
    const generation = active.current;
    if (!generation) return;
    active.current = undefined;
    generation.controller.abort();
    void workspace.cancelDraft(thread, generation.id).catch(() => {});
    setPending(false);
  };
  useEffect(
    () => () => {
      const generation = active.current;
      if (generation) {
        active.current = undefined;
        generation.controller.abort();
        void workspace
          .cancelDraft(thread, generation.id)
          .catch(() => {})
          .finally(() => {
            if (!active.current) setPending(false);
          });
      }
    },
    [workspace, thread],
  );
  useEffect(() => {
    const generation = active.current;
    if (generation && (generation.selection !== selectionKey || connection !== "ready")) {
      active.current = undefined;
      generation.controller.abort();
      void workspace
        .cancelDraft(thread, generation.id)
        .catch(() => {})
        .finally(() => {
          if (!active.current) setPending(false);
        });
    }
  }, [selectionKey, connection, workspace, thread]);
  const generate = async (auto = false) => {
    if (!props.selection || active.current || connection !== "ready") return;
    const generation = {
      id: crypto.randomUUID(),
      selection: selectionKey,
      controller: new AbortController(),
    };
    active.current = generation;
    setPending(true);
    setError(undefined);
    setProposal(undefined);
    try {
      const context = await workspace.draftContext(
        props.thread,
        props.selection,
        generation.controller.signal,
      );
      if (active.current !== generation) return;
      const result = await workspace.generateDraft(
        props.thread,
        {
          generationId: generation.id,
          selection: props.selection,
          fingerprint: context.fingerprint,
          preference,
        },
        generation.controller.signal,
      );
      if (active.current !== generation) return;
      if (auto && applyUntouched(result.draft, result.context)) return;
      setProposal({ ...result, selection: selectionKey, textRevision: props.textRevision });
    } catch (failure) {
      // A draft asked for on open fails quietly: the person writes the message by hand.
      if (active.current === generation && !auto) setError(gitFailureText(failure));
    } finally {
      if (active.current === generation) {
        active.current = undefined;
        setPending(false);
      }
    }
  };
  // Read at the moment a draft lands: whether the person has typed since the form opened.
  const applyUntouched = useEffectEvent(
    (draft: SourceControlDraft, context: SourceControlContext) => {
      if (props.edited) return false;
      props.onApply(draft, context);
      return true;
    },
  );
  const draftNow = useEffectEvent(() => {
    cancel();
    void generate(true);
  });
  // One draft per selection while the text is untouched: as the form opens, and when its files
  // change. A reconnect keeps the same selection, so it never asks again.
  const autoFor = useRef<string>(undefined);
  const hasSelection = props.selection !== undefined;
  useEffect(() => {
    if (!draftOnOpen || props.edited || !hasSelection || connection !== "ready") return;
    if (autoFor.current === selectionKey) return;
    autoFor.current = selectionKey;
    draftNow();
  }, [draftOnOpen, props.edited, hasSelection, selectionKey, connection]);
  // With no selection the key is undefined, so the proposal itself must be checked first.
  const unchanged =
    proposal !== undefined &&
    proposal.selection === selectionKey &&
    proposal.textRevision === props.textRevision;
  // No provider can write drafts: the fields stay for writing the message by hand.
  if (utility.loaded && !utility.model) return null;
  return (
    <section aria-label="Generate source-control draft" className="flex flex-col gap-2">
      <Disclosure summary="Draft writing options">
        <div className="mt-2 flex flex-col gap-2">
          <Textarea
            aria-label="Source-control writing preference"
            placeholder="Writing preference (optional), e.g. use conventional commits"
            value={preference}
            maxLength={2048}
            disabled={pending}
            onChange={(event) => setPreference(event.target.value)}
          />
        </div>
      </Disclosure>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={props.disabled || !props.selection || pending || connection !== "ready"}
          onClick={() => void generate()}
        >
          Draft
        </Button>
        {pending && (
          <Button type="button" size="sm" variant="ghost" onClick={cancel}>
            <Spinner />
            Cancel generation
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      )}
      {proposal && (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <pre aria-label="Generated draft" className="whitespace-pre-wrap break-words text-sm">
            {proposal.draft.subject}
            {"\n\n"}
            {proposal.draft.body}
          </pre>
          {!unchanged && !proposal.applied && (
            <p role="status" className="text-sm text-muted-foreground">
              Your text or selection changed. Generate again, or copy the draft manually.
            </p>
          )}
          <Button
            type="button"
            size="sm"
            disabled={proposal.applied || !unchanged || props.disabled || connection !== "ready"}
            onClick={() => {
              props.onApply(proposal.draft, proposal.context);
              setProposal({ ...proposal, applied: true });
            }}
          >
            Use draft
          </Button>
          <Disclosure summary="Sources for this draft">
            <p className="text-xs text-muted-foreground">
              HEAD {proposal.context.head ?? "unborn"}
              {proposal.context.base && ` · base ${proposal.context.base}`}
            </p>
            {proposal.context.truncated && (
              <p role="status" className="text-sm text-muted-foreground">
                Source context is truncated. Review the complete changes before submitting.
              </p>
            )}
            <ul className="text-xs">
              {proposal.context.paths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
              {proposal.context.patch}
            </pre>
            {proposal.context.conventions.map((source) => (
              <Disclosure key={source.path} summaryClassName="text-xs" summary={source.path}>
                <pre className="whitespace-pre-wrap text-xs">{source.text}</pre>
              </Disclosure>
            ))}
            <pre className="whitespace-pre-wrap text-xs">{proposal.context.recentCommits}</pre>
          </Disclosure>
        </div>
      )}
    </section>
  );
}
