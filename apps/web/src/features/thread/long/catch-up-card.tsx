import type { ThreadReader } from "@ace/client";
import { useClient } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import {
  catchUpSummaryRequest,
  catchUpView,
  formatAgo,
  formatCount,
  pluralCount,
  threadStatusLabel,
  whyNotDone,
} from "@ace/ui-core";
import { CaretDownIcon, SparkleIcon, XIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { usePhone } from "@/lib/breakpoints.ts";
import { cn } from "@/lib/cn.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useNow } from "@/lib/time.ts";
import type { CatchUp } from "./catch-up.ts";
import { Prose } from "@/components/markdown/prose.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { useThreadLiveState } from "../lib/live-state.ts";
import { DigestFacts } from "./digest-facts.tsx";
import { useWatched } from "@/lib/use-watched.ts";

/** Count the current pending requests; their actions live in the composer. */
const whyKeys = ["thread", "agents", "tasks", "interactions"] as const;

function readWhy(reader: ThreadReader) {
  const value = {
    status: reader.thread?.status,
    rootAgentId: reader.thread?.rootAgentId,
    agents: reader.agentIds().flatMap((id) => {
      const agent = reader.agent(id);
      return agent ? [agent] : [];
    }),
    requests: reader.interactionIds().flatMap((id) => {
      const interaction = reader.interaction(id);
      return interaction?.state === "pending" ? [interaction] : [];
    }),
    tasks: reader.taskIds().flatMap((id) => {
      const task = reader.task(id);
      return task ? [task] : [];
    }),
  };
  return {
    value,
    watch: [
      ...value.agents.map((agent) => `agent:${agent.id}`),
      ...value.requests.map((interaction) => `interaction:${interaction.id}`),
      ...value.tasks.map((task) => `task:${task.id}`),
    ],
  };
}

/**
 * "While you were away": what happened since this device last read the thread, from the
 * daemon's digest. Turns finished, the status now and why, files, commands and failures,
 * subagents and errors, the newest thing the agent said, and the requests waiting on the
 * person. Summarise is an explicit, ordinary message to the
 * thread's agent; nothing here asks a provider by itself. On a phone the card opens folded to
 * its heading and the status. Opening it adds its content to the transcript
 * scroll flow, so it cannot cover messages or clip its newest answer.
 */
export function CatchUpCard(props: {
  threadId: string;
  catchUp: CatchUp;
  onDismiss(): void;
  onLive(): void;
}) {
  const { digest, sinceAt } = props.catchUp;
  const view = catchUpView(digest);
  const facts = view.facts.filter((fact) => fact.kind !== "subagents");
  const now = useNow();
  const client = useClient();
  const toast = useToast();
  const workspace = useWorkspaceActions(props.threadId);
  const live = useWatched(props.threadId, whyKeys, readWhy, Object.is);
  const currentStatus = live?.status ?? digest.status;
  const status = threadStatusLabel(currentStatus);
  const freshness = useThreadLiveState(props.threadId);
  const children = live?.agents.filter((agent) => agent.id !== live.rootAgentId) ?? [];
  const finished = children.filter((agent) =>
    ["idle", "interrupted", "failed"].includes(agent.status.state),
  ).length;
  const pending = live?.requests ?? [];
  const why = whyNotDone({
    status: currentStatus,
    rootAgentId: live?.rootAgentId,
    agents: live?.agents ?? [],
    tasks: live?.tasks ?? [],
    waitingOnYou: pending.length,
    requests: pending,
  });
  const [asked, setAsked] = useState<"sending" | "sent">();
  const phone = usePhone();
  const [unfolded, setUnfolded] = useState(false);
  const open = !phone || unfolded;
  const body = useId();
  const summarise = async () => {
    setAsked("sending");
    try {
      const result = await client.command({
        type: "thread.send",
        threadId: ThreadId.parse(props.threadId),
        input: [{ type: "text", text: catchUpSummaryRequest }],
      });
      if (!result.ok) throw new Error(result.error);
      setAsked("sent");
      props.onLive();
    } catch {
      setAsked(undefined);
      toast.add({ title: "Couldn't ask for a summary", description: "Nothing was sent." });
    }
  };
  const sentLabel = asked === "sent" ? "Asked for a summary" : "Summarise";
  return (
    <section
      aria-label="While you were away"
      className={cn("flex w-full max-w-[700px] flex-col gap-2 border-b border-border py-2 text-ui")}
    >
      <header className="flex min-w-0 items-center gap-2">
        {phone ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={body}
            onClick={() => setUnfolded(!unfolded)}
            className="focus-ring -mx-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 text-left"
          >
            <h2 className="truncate text-ui font-medium text-foreground">While you were away</h2>
            <span className="shrink-0 text-xs text-subtle-foreground">
              {formatAgo(sinceAt, now)}
            </span>
            <CaretDownIcon
              aria-hidden
              size={14}
              className={cn(
                "shrink-0 text-subtle-foreground transition-transform duration-(--dur-2)",
                !open && "-rotate-90",
              )}
            />
          </button>
        ) : (
          <>
            <h2 className="text-ui font-medium text-foreground">While you were away</h2>
            <span className="text-xs text-subtle-foreground">since {formatAgo(sinceAt, now)}</span>
          </>
        )}
        {phone ? (
          <IconButton
            icon={SparkleIcon}
            label={sentLabel}
            size="sm"
            disabled={asked !== undefined}
            onClick={() => void summarise()}
          />
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={asked !== undefined}
            onClick={() => void summarise()}
          >
            <SparkleIcon aria-hidden size={14} />
            {sentLabel}
          </Button>
        )}
        <IconButton icon={XIcon} label="Dismiss" size="sm" onClick={props.onDismiss} />
      </header>
      {freshness.fresh && (
        <p className="flex items-start gap-2 text-ui">
          <StatusLabel tone={status.tone} label={status.label} />
          <span className={cn("text-muted-foreground", !open && "line-clamp-1")}>{why.body}</span>
        </p>
      )}
      {open && (
        <div id={body} className="flex flex-col gap-2.5">
          <p className="flex min-w-0 items-center gap-1.5 text-ui text-muted-foreground">
            <span className="shrink-0 text-foreground">{view.headline}</span>
            {facts.length > 0 && (
              <span aria-hidden className="text-subtle-foreground">
                ·
              </span>
            )}
            <DigestFacts facts={facts} />
          </p>
          {view.files.length > 0 && (
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 truncate font-mono">
                {view.files.map((file) => file.path).join("  ")}
                {view.moreFiles > 0 && ` and ${formatCount(view.moreFiles)} more`}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => workspace.open({ kind: "changes" })}
              >
                Open Changes
              </Button>
            </div>
          )}
          {(view.commandLine || children.length > 0) && (
            <p className="text-xs text-muted-foreground">
              {[
                view.commandLine,
                children.length
                  ? `${formatCount(finished)} of ${pluralCount(children.length, "subagent")} finished`
                  : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          {view.failedCommands.length > 0 && (
            <ul aria-label="Failed commands" className="flex flex-col gap-1">
              {view.failedCommands.map((command) => (
                <li key={command.itemId} className="flex min-w-0 items-center gap-2 text-xs">
                  <Dot tone="failed" />
                  <code className="min-w-0 truncate font-mono text-foreground">
                    {command.command}
                  </code>
                  {command.exitCode !== undefined && command.exitCode !== null && (
                    <span className="shrink-0 text-subtle-foreground">exit {command.exitCode}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {view.latestMessage && (
            <div className="border-t border-border pt-2.5 text-ui text-muted-foreground">
              <span className="text-subtle-foreground">Latest: </span>
              <Prose text={view.latestMessage} className="inline [&_p]:inline" />
            </div>
          )}
          {!digest.ready && (
            <p className="text-xs text-subtle-foreground">
              Older history is still being indexed; some counts may be missing.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
