import type { ThreadReader } from "@ace/client";
import { useClient, useThread } from "@ace/client-react";
import { ThreadId, type CommandPayload } from "@ace/protocol";
import { ArrowClockwiseIcon, PauseIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { failureMessage, runCommand } from "@/lib/daemon-command.ts";
import { useActiveRootRun } from "../composer/stop-state.ts";
import { floatingControl, floatingHover, floatingMotion } from "./floating.ts";

/** Why the turn stopped, when it stopped and nothing has run since. */
const stopOf = (reader: ThreadReader) =>
  reader.queue?.paused && (reader.queue.reason === "restart" || reader.queue.reason === "stopped")
    ? reader.queue.reason
    : undefined;

/**
 * A stopped turn as a pill in the Jump to live spot, never an item in the queue's strip:
 * "Stopped by a restart · Continue". Continue sends one continuation; a message the person sends
 * instead simply starts the next turn. Nothing continues by itself, and the pill leaves as soon
 * as a turn runs. With Jump to live showing too, it sits just above it.
 */
export function StoppedPill(props: { threadId: string; raised: boolean }) {
  const client = useClient();
  const toast = useToast();
  const reason = useThread(props.threadId, ["queue"], stopOf);
  const running = !!useActiveRootRun(props.threadId);
  const [sending, setSending] = useState(false);
  if (!reason || running) return null;
  const label = reason === "restart" ? "Stopped by a restart" : "Agent stopped";
  const Glyph = reason === "restart" ? ArrowClockwiseIcon : PauseIcon;
  const go = () => {
    setSending(true);
    void (async () => {
      const threadId = ThreadId.parse(props.threadId);
      const { queue } = await client.request({ type: "queue.get", threadId, limit: 1 });
      // A restart left a native continuation to resume; a Stop left none, so Continue says so.
      const payload: CommandPayload =
        reason === "restart"
          ? { type: "thread.resume", threadId, expectedRevision: queue.revision }
          : {
              type: "thread.send",
              threadId,
              input: [{ type: "text", text: "continue" }],
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
          "h-6 rounded-full px-2.5 font-medium text-foreground transition-colors duration-(--motion-fast) focus-ring disabled:opacity-60 touch-hit",
        )}
      >
        Continue
      </button>
    </div>
  );
}
