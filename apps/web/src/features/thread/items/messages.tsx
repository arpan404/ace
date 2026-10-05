import type { ThreadReader } from "@ace/client";
import { useAgent, useItem, useThread } from "@ace/client-react";
import { CheckIcon, CopyIcon, GitForkIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { forkPointOf } from "../transitions/fork-point.ts";
import { useForkOpener } from "../transitions/fork-opener.ts";

/** Agent prose. A subagent's message carries its name, as the design's "reconnect-audit found…". */
export function AssistantMessage(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  const agent = useAgent(props.threadId, item?.agentId ?? "");
  if (item?.type !== "message") return null;
  const text = item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  const name = agent && agent.origin !== "root" ? (agent.name ?? "Subagent") : undefined;
  return (
    <div className="group/answer text-prose leading-[1.6] tracking-[-0.005em]">
      {name && <p className="mb-1 text-ui font-medium text-muted-foreground">{name}</p>}
      <Prose text={text} />
      {!item.complete && (
        <span
          role="status"
          aria-label="Streaming"
          className="ml-0.5 inline-block h-[1em] w-[3px] animate-pulse rounded-full bg-current align-[-0.15em] text-muted-foreground"
        />
      )}
      {item.complete && (
        <div className="mt-1 flex opacity-0 transition-opacity duration-(--dur-1) group-focus-within/answer:opacity-100 group-hover/answer:opacity-100">
          <CopyAnswer text={text} />
          {!name && <ForkHere threadId={props.threadId} itemId={props.itemId} />}
        </div>
      )}
    </div>
  );
}

/** Copies the answer's markdown, as written, with a moment of "Copied". */
function CopyAnswer(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  const copy = () =>
    void navigator.clipboard?.writeText(props.text).then(
      () => {
        setCopied(true);
        clearTimeout(reset.current);
        reset.current = setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  return (
    <IconButton
      icon={copied ? CheckIcon : CopyIcon}
      label={copied ? "Copied" : "Copy answer"}
      size="sm"
      onClick={copy}
    />
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
    <IconButton icon={GitForkIcon} label="Fork from here" size="sm" onClick={() => open(point)} />
  );
}

const samePoint = (a: ReturnType<typeof forkPointOf>, b: ReturnType<typeof forkPointOf>) =>
  JSON.stringify(a) === JSON.stringify(b);
