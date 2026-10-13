import { gitFailureText } from "../lib/git-failure.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnectionState } from "@ace/client-react";
import type {
  SourceControlContext,
  SourceControlDraft,
  SourceControlSelection,
} from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import { Disclosure } from "@/components/ui/disclosure.tsx";

/** Requests are event-driven. Reconnect, edits and selection changes never request another draft. */
export function DraftWriter(props: {
  thread: ThreadRef;
  selection: SourceControlSelection | undefined;
  textRevision: number;
  disabled: boolean;
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
  const [provider, setProvider] = useState<"claude" | "codex">(
    props.thread.provider === "claude" ? "claude" : "codex",
  );
  const [model, setModel] = useState("");
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
  const generate = async () => {
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
          provider,
          ...(model.trim() ? { model: model.trim() } : {}),
          preference,
        },
        generation.controller.signal,
      );
      if (active.current !== generation) return;
      setProposal({ ...result, selection: selectionKey, textRevision: props.textRevision });
    } catch (failure) {
      if (active.current === generation) setError(gitFailureText(failure));
    } finally {
      if (active.current === generation) {
        active.current = undefined;
        setPending(false);
      }
    }
  };
  // With no selection the key is undefined, so the proposal itself must be checked first.
  const unchanged =
    proposal !== undefined &&
    proposal.selection === selectionKey &&
    proposal.textRevision === props.textRevision;
  return (
    <section aria-label="Generate source-control draft" className="flex flex-col gap-2">
      <Disclosure summary="Draft writing options">
        <div className="mt-2 flex flex-col gap-2">
          <Select
            label="Draft provider"
            value={provider}
            options={[
              { value: "codex", label: "Codex CLI" },
              { value: "claude", label: "Claude Code CLI" },
            ]}
            disabled={pending}
            onValueChange={(value) => {
              if (value === "claude" || value === "codex") setProvider(value);
            }}
          />
          <Input
            aria-label="Draft model"
            placeholder="Model ID (CLI default when blank)"
            value={model}
            maxLength={256}
            disabled={pending}
            onChange={(event) => setModel(event.target.value)}
          />
          <Textarea
            aria-label="Source-control writing preference"
            placeholder="Writing preference (optional), e.g. use conventional commits"
            value={preference}
            maxLength={2048}
            disabled={pending}
            onChange={(event) => setPreference(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Uses your installed CLI's default login. Options apply to this draft only.
          </p>
        </div>
      </Disclosure>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={props.disabled || !props.selection || pending || connection !== "ready"}
          onClick={() => void generate()}
        >
          Generate draft
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
