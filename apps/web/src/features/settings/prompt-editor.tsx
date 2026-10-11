import { promptFields, updatePrompt } from "@ace/commands/prompt-format";
import { useBlocker } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.tsx";
import { promptProblem } from "./prompt-copy.ts";
import type { PromptFile, PromptFileScope } from "@ace/protocol";
import { useClient } from "@ace/client-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

export function PromptEditor(props: {
  file?: PromptFile | undefined;
  scope: PromptFileScope;
  onSaved(file: PromptFile): void;
  onClose(): void;
  onDirtyChange?(dirty: boolean): void;
}) {
  const client = useClient();
  const { onDirtyChange } = props;
  const [name, setName] = useState(props.file?.name ?? "");
  const [text, setText] = useState<string>();
  const [source, setSource] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const committed = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [diagnostics, setDiagnostics] = useState(props.file?.diagnostics ?? []);
  const read = useQuery({
    queryKey: ["prompt-file", props.file?.scope, props.file?.name],
    enabled: !!props.file,
    queryFn: async ({ signal }) => {
      const reply = await client.request(
        {
          type: "prompts.request",
          operation: { op: "read", scope: props.scope, name: props.file?.name ?? "" },
        },
        { signal },
      );
      if (reply.result.kind !== "file")
        throw new Error(
          reply.result.kind === "error"
            ? reply.result.message
            : "Couldn't open this prompt. Try again.",
        );
      return reply.result;
    },
    staleTime: 0,
  });
  const content =
    text ??
    read.data?.text ??
    '---\ndescription: ""\nprovider: any\n---\nWrite your prompt here.\n';
  const initial =
    read.data?.text ?? '---\ndescription: ""\nprovider: any\n---\nWrite your prompt here.\n';
  const dirty = content !== initial || name !== (props.file?.name ?? "");
  const fields = promptFields(content);
  const sourceMode = source || !fields;
  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !committed.current,
    withResolver: true,
  });
  useEffect(() => {
    onDirtyChange?.(dirty);
    const leaving = (event: BeforeUnloadEvent) => {
      if (dirty && !committed.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", leaving);
    return () => {
      window.removeEventListener("beforeunload", leaving);
      onDirtyChange?.(false);
    };
  }, [dirty, onDirtyChange]);
  const patch = (value: Parameters<typeof updatePrompt>[1]) =>
    setText(updatePrompt(content, value));
  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const reply = await client.request({
        type: "prompts.request",
        operation: {
          op: "write",
          scope: props.scope,
          name,
          text: content,
          expectedRevision: read.data?.revision ?? null,
        },
      });
      if (reply.result.kind !== "file")
        throw new Error(
          reply.result.kind === "error"
            ? reply.result.message
            : "Couldn't save this prompt. Try again.",
        );
      setDiagnostics(reply.result.file.diagnostics);
      committed.current = true;
      props.onSaved(reply.result.file);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't save this prompt. Reconnect and try again.",
      );
    } finally {
      setSaving(false);
    }
  };
  if (props.file && read.isPending) return <Spinner label="Opening prompt" />;
  if (read.isError && props.file)
    return (
      <p role="alert">
        {read.error.message}{" "}
        <Button variant="secondary" size="sm" onClick={() => void read.refetch()}>
          Try again
        </Button>
      </p>
    );
  return (
    <>
      <form
        className="mt-6 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="text-ui">
          File name
          <Input
            aria-label="Prompt file name"
            value={name}
            disabled={!!props.file || saving}
            placeholder="review.md"
            pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md"
            required
            maxLength={132}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {!sourceMode && fields && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-ui">
              Name
              <Input
                aria-label="Prompt name"
                placeholder="Uses the file name when empty"
                disabled={saving}
                value={fields.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </label>
            <label className="text-ui">
              Provider
              <Input
                aria-label="Prompt provider"
                disabled={saving}
                value={fields.provider}
                onChange={(event) => patch({ provider: event.target.value })}
              />
            </label>
            <label className="text-ui sm:col-span-2">
              Description
              <Input
                aria-label="Prompt description"
                disabled={saving}
                value={fields.description}
                onChange={(event) => patch({ description: event.target.value })}
              />
            </label>
          </div>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={sourceMode}
          onClick={() => setSource(!sourceMode)}
          disabled={!fields || saving}
        >
          Edit source
        </Button>
        <label className="text-ui">
          {sourceMode ? "Source" : "Prompt"}
          <Textarea
            aria-label="Prompt content"
            readOnly={saving}
            value={sourceMode ? content : (fields?.body ?? content)}
            maxLength={65536}
            onChange={(event) =>
              sourceMode ? setText(event.target.value) : patch({ body: event.target.value })
            }
            className={sourceMode ? "min-h-64 font-mono" : "min-h-64 text-base"}
          />
        </label>
        <p className="text-sm text-muted-foreground">
          Markdown with optional name, description, provider and arguments in frontmatter. Use{" "}
          {"{{argument}}"} in the prompt text.
        </p>
        {!!diagnostics.length && (
          <ul aria-label="Prompt diagnostics" className="text-ui text-status-failed">
            {diagnostics.map((diagnostic) => (
              <li key={`${diagnostic.source}:${diagnostic.message}`}>
                {promptProblem(diagnostic.message)}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-ui text-status-failed">
            {error}{" "}
            {error.includes("changed") && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setText(undefined);
                  setError(undefined);
                  void read.refetch();
                }}
              >
                Reload prompt
              </Button>
            )}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => (dirty ? setCanceling(true) : props.onClose())}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !name}>
            Save prompt
          </Button>
        </div>
      </form>
      <Dialog
        open={canceling || blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) {
            setCanceling(false);
            blocker.reset?.();
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Discard changes to this prompt?</DialogTitle>
            <DialogDescription>What you changed here hasn't been saved.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setCanceling(false);
                blocker.reset?.();
              }}
            >
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                committed.current = true;
                if (blocker.status === "blocked") blocker.proceed?.();
                else props.onClose();
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
