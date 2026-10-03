import { useAgent, useItem } from "@ace/client-react";
import { FileIcon } from "@phosphor-icons/react";
import { formatClock } from "@ace/ui-core";
import { Prose } from "../markdown/prose.tsx";

/** The person's message: a right-aligned bubble with its time below. */
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
    <div className="flex flex-col items-end">
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
      <span className="mt-[5px] pr-1 text-xs text-subtle-foreground">
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
    <div className="text-prose leading-[1.6] tracking-[-0.005em]">
      {name && <p className="mb-1 text-ui font-medium text-muted-foreground">{name}</p>}
      <Prose text={text} />
      {!item.complete && (
        <span
          role="status"
          aria-label="Streaming"
          className="ml-0.5 inline-block h-[1em] w-[3px] animate-pulse rounded-full bg-current align-[-0.15em] text-muted-foreground"
        />
      )}
    </div>
  );
}
