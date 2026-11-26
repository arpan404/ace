import { spadeDocumentFacts, type SpadeDocumentRef } from "@ace/ui-core/spade-chat";
import { CaretDownIcon } from "@ace/icons";
import { useState } from "react";
import { describeFile } from "@/components/attachment-kind.ts";
import { FileName } from "@/components/attachment-face.tsx";
import { Icon } from "@/components/icon.tsx";
import { part } from "@/lib/suit-part.ts";
import { cn } from "@/lib/cn.ts";
import { DocumentThumb } from "./spade-attachment-thumb.tsx";
import { DocumentActions } from "./spade-attachment-parts.tsx";
import { useAttachmentActions } from "./spade-attachment-actions.ts";

/** "PDF · 12 pages · 482 KB": the type, its pages or sheets, then its size. */
export function documentFacts(document: SpadeDocumentRef) {
  const { label } = describeFile({ name: document.name, mimeType: document.mediaType });
  return [label, spadeDocumentFacts(document)].filter(Boolean).join(" · ");
}

/** One document: a type tile, its name (the middle gives way first) and its facts. */
export function DocumentCard(props: {
  document: SpadeDocumentRef;
  side: "person" | "bot";
  /** Drawn inside a message bubble: a quiet inset in the bubble's own colour, full width. */
  inside?: boolean;
}) {
  const { document } = props;
  const actions = useAttachmentActions();
  const open = actions.openDocument;
  return (
    <div
      {...part("spade-attachment", undefined, props.inside ? "inside" : "alone")}
      role="group"
      aria-label={document.name}
      className={cn(
        "group/attachment flex w-full max-w-72 min-w-0 items-center gap-2.5 rounded-2xl py-2 pr-1.5 pl-2.5",
        props.inside
          ? props.side === "person"
            ? "bg-chat-mine-code text-chat-mine-foreground"
            : "bg-chat-well text-foreground"
          : props.side === "person"
            ? "bg-surface-2 text-foreground"
            : "bg-bubble shadow-[inset_0_0_0_1px_var(--border-soft)]",
      )}
    >
      <button
        type="button"
        disabled={!open}
        aria-label={open ? `Open ${document.name}` : undefined}
        onClick={() => open?.(document)}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left focus-ring enabled:cursor-pointer"
      >
        <DocumentThumb document={document} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("min-w-0 text-ui font-medium", !props.inside && "text-foreground")}>
            <FileName name={document.name} />
          </span>
          <span
            className={cn(
              "truncate text-xs",
              props.inside ? "opacity-70" : "text-muted-foreground",
            )}
          >
            {documentFacts(document)}
          </span>
        </span>
      </button>
      <DocumentActions document={document} />
    </div>
  );
}

const collapsedAt = 3;

/** Several documents as a list, collapsed past three behind "N more". */
export function DocumentList(props: {
  documents: readonly SpadeDocumentRef[];
  side: "person" | "bot";
  inside?: boolean;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? props.documents : props.documents.slice(0, collapsedAt);
  const hidden = props.documents.length - shown.length;
  return (
    <div
      className={cn(
        "flex w-full max-w-72 flex-col gap-1",
        props.side === "person" ? "items-end" : "items-start",
      )}
    >
      {/* The same file twice in one message shows twice: keyed by place. */}
      {shown.map((document, place) => (
        <DocumentCard
          key={`${document.sha256}:${shown.slice(0, place).filter((each) => each.sha256 === document.sha256).length}`}
          document={document}
          side={props.side}
          inside={props.inside ?? false}
        />
      ))}
      {props.documents.length > collapsedAt && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll(!all)}
          className="flex h-7 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground focus-ring hover:text-foreground"
        >
          {all ? "Show fewer" : `${hidden} more`}
          <Icon icon={CaretDownIcon} size={12} className={cn(all && "rotate-180")} />
        </button>
      )}
    </div>
  );
}
