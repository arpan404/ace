import { PlusIcon } from "@phosphor-icons/react";
import type { PluginReviewEntry } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import {
  PluginNameInput,
  PluginRef,
  PluginRepository,
  pluginSkillId,
  suggestedPluginName,
} from "./skills-model.ts";
import {
  useAcceptPlugin,
  useCancelReview,
  usePreparePlugin,
  type PreparedPlugin,
} from "./skills-source.ts";

const failure = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/**
 * "+" in the Skills header: install a plugin. The daemon fetches the repository and pins the
 * plugin for review; nothing it ships runs until you accept exactly what the review shows.
 */
export function InstallPlugin() {
  const [open, setOpen] = useState(false);
  const [prepared, setPrepared] = useState<PreparedPlugin>();
  const cancel = useCancelReview();
  const close = (next: boolean) => {
    // Closing during review drops the pin, so the daemon doesn't keep it.
    if (!next && prepared) cancel.mutate(prepared.review.id);
    if (!next) setPrepared(undefined);
    setOpen(next);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger render={<IconButton icon={PlusIcon} label="Add skill or plugin" />} />
      <DialogContent>
        {prepared ? (
          <Review
            prepared={prepared}
            onDone={() => {
              setPrepared(undefined);
              setOpen(false);
            }}
            onBack={() => close(false)}
          />
        ) : (
          <Source onPrepared={setPrepared} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field(props: {
  label: string;
  value: string;
  placeholder: string;
  onChange(value: string): void;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-muted-foreground">
        {props.label}
      </label>
      <Input
        id={id}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        spellCheck={false}
        autoComplete="off"
        className="font-mono text-[12.5px]"
      />
    </div>
  );
}

function Source(props: { onPrepared(prepared: PreparedPlugin): void }) {
  const [repository, setRepository] = useState("");
  const [ref, setRef] = useState("main");
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const prepare = usePreparePlugin();
  const submit = async () => {
    const source = PluginRepository.safeParse(repository);
    const pin = PluginRef.safeParse(ref);
    const plugin = PluginNameInput.safeParse(name || suggestedPluginName(repository));
    if (!source.success || !pin.success || !plugin.success) {
      setError((source.error ?? pin.error ?? plugin.error)?.issues[0]?.message);
      return;
    }
    setError(undefined);
    try {
      props.onPrepared(
        await prepare.mutateAsync({ repository: source.data, ref: pin.data, name: plugin.data }),
      );
    } catch (reason) {
      setError(failure(reason, "The daemon couldn't fetch that plugin."));
    }
  };
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Install a plugin</DialogTitle>
        <DialogDescription>
          ace fetches the repository, finds the plugin in its marketplace and shows you what it
          runs. Nothing is enabled until you accept.
        </DialogDescription>
      </DialogHeader>
      <Field
        label="Repository"
        value={repository}
        placeholder="getsentry/sentry-mcp"
        onChange={setRepository}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Plugin"
          value={name}
          placeholder={suggestedPluginName(repository) || "sentry"}
          onChange={setName}
        />
        <Field label="Branch or tag" value={ref} placeholder="main" onChange={setRef} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" variant="primary" disabled={prepare.isPending}>
          {prepare.isPending ? "Fetching…" : "Review"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function describe(entry: PluginReviewEntry): { title: string; detail: string } {
  if (entry.type === "diagnostic") return { title: "Note", detail: entry.message };
  const execution = entry.execution;
  switch (execution.kind) {
    case "hook":
      return { title: `Hook on ${execution.event}`, detail: execution.command };
    case "stdio":
      return {
        title: `MCP server ${execution.name}`,
        detail: [execution.command, ...execution.args].join(" "),
      };
    case "remote":
      return { title: `Remote MCP ${execution.name}`, detail: execution.url };
  }
}

function Review(props: { prepared: PreparedPlugin; onDone(): void; onBack(): void }) {
  const { review, entries } = props.prepared;
  const accept = useAcceptPlugin();
  const toast = useToast();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const install = async () => {
    try {
      await accept.mutateAsync(review);
      toast.add({ title: `Installed ${review.name}` });
      props.onDone();
      await navigate({ to: "/skills/$skillId", params: { skillId: pluginSkillId(review.name) } });
    } catch (reason) {
      setError(failure(reason, "The plugin didn't install."));
    }
  };
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          Review {review.name} {review.version}
        </DialogTitle>
        <DialogDescription>
          Pinned at <code>{review.commit.slice(0, 12)}</code>.{" "}
          {review.executionCount
            ? "Once enabled it runs the commands below on this machine."
            : "It runs nothing on this machine: it ships prompts only."}
          {review.unsupportedCount > 0 &&
            ` ${review.unsupportedCount} part${review.unsupportedCount === 1 ? "" : "s"} ace can't load will be skipped.`}
        </DialogDescription>
      </DialogHeader>
      {entries.length > 0 && (
        <ul aria-label="What it runs" className="max-h-64 overflow-auto">
          {entries.map((entry) => {
            const { title, detail } = describe(entry);
            return (
              <li
                key={`${title}\u0000${detail}`}
                className="border-t py-2 text-ui first:border-t-0"
              >
                <div className="font-medium">{title}</div>
                <code className="text-sm break-all text-muted-foreground">{detail}</code>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={props.onBack}>
          Cancel
        </Button>
        <Button variant="primary" disabled={accept.isPending} onClick={() => void install()}>
          Install
        </Button>
      </DialogFooter>
    </div>
  );
}
