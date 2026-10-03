import type { ThreadReader } from "@ace/client";
import { useAgent, useItem, useThread } from "@ace/client-react";
import { FileIcon, GitForkIcon } from "@phosphor-icons/react";
import { useCallback } from "react";
import { formatClock } from "@ace/ui-core";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Prose } from "../markdown/prose.tsx";
import { forkPointOf } from "../transitions/fork-point.ts";
import { useForkOpener } from "../transitions/fork-dialog.tsx";

/** The person's message: a right-aligned bubble; its time shows on hover, keeping the column quiet. */
export function UserMessage(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  if (item?.type !== "message") return null;
  const text = item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  const files = item.parts.flatMap((part) => (part.type === "file" ? [part.path] : []));
  // Images come from the daemon; only inline data, blobs and web URLs are loaded.
  const images = item.parts.flatMap((part) =>
    part.type === "image" && /^(data:image\/|blob:|https?:)/.test(part.url) ? [part] : [],
  );
  return (
    <div className="group/bubble flex flex-col items-end">
      <div className="max-w-[82%] rounded-[16px_16px_4px_16px] bg-bubble px-[15px] py-2.5 text-[15px] leading-[1.55] tracking-[-0.005em] wrap-break-word whitespace-pre-wrap">
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((image) => (
              <img
                key={image.url}
                src={image.url}
                alt="Attached image"
                className="max-h-40 rounded-md object-cover"
              />
            ))}
          </div>
        )}
        {text}
        {files.length > 0 && (
          <span className="mt-2 flex flex-wrap gap-1.5">
            {files.map((path) => (
              <span
                key={path}
                className="inline-flex items-center gap-1 rounded-sm bg-secondary px-1.5 font-mono text-xs text-muted-foreground"
              >
                <FileIcon aria-hidden size={12} />
                {path}
              </span>
            ))}
          </span>
        )}
      </div>
      <span className="mt-[5px] pr-1 text-xs text-subtle-foreground opacity-0 transition-opacity duration-(--dur-1) group-focus-within/bubble:opacity-100 group-hover/bubble:opacity-100">
        {formatClock(item.createdAt)}
      </span>
    </div>
  );
}

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
