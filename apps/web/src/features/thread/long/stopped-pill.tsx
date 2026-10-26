import type { ThreadReader } from "@ace/client";
import { useClient, useThread } from "@ace/client-react";
import { ThreadId, type CommandPayload } from "@ace/protocol";
import { continueMessage, stopTitle } from "@ace/ui-core";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { PauseBarsIcon, ResumeIcon } from "@/components/ace-icons.tsx";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { failureMessage, runCommand } from "@/lib/daemon-command.ts";
import { useActiveRootRun } from "../composer/stop-state.ts";
import { floatingControl, floatingHover, floatingMotion } from "./floating.ts";

/** Why the turn stopped, when it stopped and nothing has run since. */
const stopOf = (reader: ThreadReader) => {
  const queue = reader.queue;
  const label = stopTitle(queue, reader.thread?.provider);
  if (!label || !queue) return undefined;
  // A restart and a provider that died both leave a continuation to resume; a Stop leaves none.
  return { resumes: queue.reason === "restart", exited: queue.exited === true, label };
};
type Stop = NonNullable<ReturnType<typeof stopOf>>;
const sameStop = (a: Stop | undefined, b: Stop | undefined) =>
  a === b ||
  (!!a && !!b && a.resumes === b.resumes && a.exited === b.exited && a.label === b.label);

/**
 * A stopped turn as a pill in the Scroll to end spot, never an item in the queue's strip:
 * "Stopped by a restart · Continue", or "Cursor stopped unexpectedly · Continue" when the
 * provider's process died. Continue sends one continuation; a message the person sends instead
 * simply starts the next turn. Nothing continues by itself, and the pill leaves as soon
 * as a turn runs. With Scroll to end showing too, it sits just above it.
 */
export function StoppedPill(props: { threadId: string; raised: boolean }) {
  const client = useClient();
  const toast = useToast();
  const stop = useThread(props.threadId, ["queue", "thread"], stopOf, sameStop);
  const running = !!useActiveRootRun(props.threadId);
  const [sending, setSending] = useState(false);
  if (!stop || running) return null;
  const { label, resumes } = stop;
  const Glyph = resumes && !stop.exited ? ArrowClockwiseIcon : PauseBarsIcon;
  const go = () => {
    setSending(true);
    void (async () => {
      const threadId = ThreadId.parse(props.threadId);
      const { queue } = await client.request({ type: "queue.get", threadId, limit: 1 });
      // A restart left a native continuation to resume (the daemon sends it in the person's
      // words); a Stop left none, so Continue is simply their next message.
      const payload: CommandPayload = resumes
        ? { type: "thread.resume", threadId, expectedRevision: queue.revision }
        : {
            type: "thread.send",
            threadId,
            input: [{ type: "text", text: continueMessage }],
            delivery: "queue",
          };
      await runCommand(client, payload, crypto.randomUUID());
    })()
      .catch((error: unknown) =>
        toast.error({ title: "Couldn't continue", description: failureMessage(error) }),
      )
      .finally(() => setSending(false));
  };
  return (
    <div
      role="status"
      aria-label={label}
      className={cn(
        floatingControl,
        floatingMotion("enter"),
        "absolute left-[calc(50%-var(--summary-inset,0px)/2)] z-20 -translate-x-1/2 pr-1 pl-3 whitespace-nowrap",
        props.raised
          ? "bottom-[min(calc(var(--composer-clearance,0px)+3.25rem),calc(100%-5.25rem))]"
          : "bottom-[min(calc(var(--composer-clearance,0px)+0.75rem),calc(100%-2.75rem))]",
      )}
    >
      <Glyph aria-hidden size={14} weight="bold" className="text-muted-foreground" />
      <span className="text-muted-foreground">{label} ·</span>
      <button
        type="button"
        disabled={sending}
        onClick={go}
        className={cn(
          floatingHover,
          "inline-flex h-6 items-center gap-1 rounded-full px-2.5 font-medium text-foreground transition-colors duration-(--motion-fast) focus-ring disabled:opacity-60 touch-hit",
        )}
      >
        <ResumeIcon aria-hidden size={12} />
        Continue
      </button>
    </div>
  );
}
