import type { ThreadReader } from "@ace/client";
import { useAgent, useItem, useThread } from "@ace/client-react";
import { GitForkIcon } from "@phosphor-icons/react";
import { useCallback } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { forkPointOf } from "../transitions/fork-point.ts";
import { useForkOpener } from "../transitions/fork-opener.ts";
import { useStreaming } from "../transcript/use-streaming.ts";

/** Agent prose. A subagent's message carries its name, as the design's "reconnect-audit found…". */
export function AssistantMessage(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  const agent = useAgent(props.threadId, item?.agentId ?? "");
  // Text left incomplete by a turn that stopped or failed no longer streams.
  const streaming = useStreaming(props.threadId, item);
  if (item?.type !== "message") return null;
  const text = item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  const name = agent && agent.origin !== "root" ? (agent.name ?? "Subagent") : undefined;
  return (
    <div className="group/answer text-prose leading-[1.6] tracking-[-0.005em]">
      {name && <p className="mb-1 text-ui font-medium text-muted-foreground">{name}</p>}
      <Prose text={text} />
      {streaming && (
        <span
          role="status"
          aria-label="Streaming"
          className="ml-0.5 inline-block h-[1em] w-[3px] animate-pulse rounded-full bg-current align-[-0.15em] text-muted-foreground"
        />
      )}
      {!name && <ForkHere threadId={props.threadId} itemId={props.itemId} />}
    </div>
  );
}

/** Under a finished answer of the main agent, on hover: fork the thread from that turn. */
function ForkHere(props: { threadId: string; itemId: string }) {
  const open = useForkOpener();
  const read = useCallback(
    (reader: ThreadReader) => {
      const item = reader.item(props.itemId);
      return forkPointOf(item, item?.runId === undefined ? undefined : reader.run(item.runId));
    },
    [props.itemId],
  );
  const item = useItem(props.threadId, props.itemId);
  const keys = [
    `item:${props.itemId}`,
    ...(item?.runId ? [`run:${item.runId}` as const] : []),
  ] as const;
  const point = useThread(props.threadId, keys, read, samePoint);
  if (!open || !point) return null;
  return (
    <div className="mt-1 flex opacity-0 transition-opacity duration-(--dur-1) group-focus-within/answer:opacity-100 group-hover/answer:opacity-100">
      <IconButton icon={GitForkIcon} label="Fork from here" size="sm" onClick={() => open(point)} />
    </div>
  );
}

const samePoint = (a: ReturnType<typeof forkPointOf>, b: ReturnType<typeof forkPointOf>) =>
  JSON.stringify(a) === JSON.stringify(b);
