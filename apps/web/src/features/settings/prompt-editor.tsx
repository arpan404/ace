import type { PromptFile, PromptFileScope } from "@ace/protocol";
import { useClient } from "@ace/client-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

export function PromptEditor(props: {
  file?: PromptFile | undefined;
  scope: PromptFileScope;
  onSaved(file: PromptFile): void;
  onClose(): void;
}) {
  const client = useClient();
  const [name, setName] = useState(props.file?.name ?? "");
  const [text, setText] = useState<string>();
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
    "---\nname: new-prompt\ndescription: \nprovider: any\n---\nWrite your prompt here.\n";
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
        <Button variant="ghost" size="sm" onClick={() => void read.refetch()}>
          Try again
        </Button>
      </p>
    );
  return (
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
          disabled={!!props.file}
          placeholder="review.md"
          pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md"
          required
          maxLength={132}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="text-ui">
        Prompt
        <Textarea
          aria-label="Prompt content"
          value={content}
          maxLength={65536}
          onChange={(event) => setText(event.target.value)}
          className="min-h-64 font-mono"
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
              {diagnostic.message === "Invalid command metadata or document"
                ? "The prompt’s heading or arguments couldn’t be read. Check the names and indentation."
                : diagnostic.message}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-ui text-status-failed">
          {error}{" "}
          {error.includes("changed") && (
            <Button
              variant="ghost"
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
        <Button type="button" variant="ghost" onClick={props.onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving || !name}>
          Save prompt
        </Button>
      </div>
    </form>
  );
}
