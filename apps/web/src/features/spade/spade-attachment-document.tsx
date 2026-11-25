import { spadeDocumentFacts, type SpadeDocumentRef } from "@ace/ui-core/spade-chat";
import { CaretDownIcon } from "@ace/icons";
import { useState } from "react";
import { describeFile } from "@/components/attachment-kind.ts";
import { FileName, kindGlyph } from "@/components/attachment-face.tsx";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import { DocumentActions } from "./spade-attachment-parts.tsx";
import { useAttachmentActions } from "./spade-attachment-actions.ts";

/** "PDF · 12 pages · 482 KB": the type, its pages or sheets, then its size. */
export function documentFacts(document: SpadeDocumentRef) {
  const { label } = describeFile({ name: document.name, mimeType: document.mediaType });
  return [label, spadeDocumentFacts(document)].filter(Boolean).join(" · ");
}

/** One document: a type tile, its name (the middle gives way first) and its facts. */
export function DocumentCard(props: { document: SpadeDocumentRef; side: "person" | "bot" }) {
  const { document } = props;
  const actions = useAttachmentActions();
  const { kind } = describeFile({ name: document.name, mimeType: document.mediaType });
  const open = actions.openDocument;
  return (
    <div
      role="group"
      aria-label={document.name}
      className={cn(
        "group/attachment flex w-full max-w-72 min-w-0 items-center gap-2.5 rounded-2xl py-2 pr-1.5 pl-2.5",
        props.side === "person"
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
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-hover text-muted-foreground">
          <Icon icon={kindGlyph(kind)} size={20} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 text-ui font-medium text-foreground">
            <FileName name={document.name} />
          </span>
          <span className="truncate text-xs text-muted-foreground">{documentFacts(document)}</span>
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
        <DocumentCard key={`${place}:${document.sha256}`} document={document} side={props.side} />
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
