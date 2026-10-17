import {
  ChatTeardropTextIcon,
  ImageIcon,
  PencilSimpleIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { ImageUrl } from "@/components/attachment-bytes.tsx";
import type { ImageSource } from "@/components/attachment-format.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import type { AnnotationItem, DraftAnnotationsState } from "./draft-annotations.ts";
import { MarkerNumber, TagBadge } from "./marker.tsx";
import { badgeFor, regionContents } from "./region-summary.ts";
import { useSessionPort, type AnnotationSessionPort } from "./store.ts";

export const annotationCount = (count: number) =>
  `${count} ${count === 1 ? "annotation" : "annotations"}`;

/** "2 style changes · text changed": the edits previewed on the element, if any. */
export function changeSummary(styles: number, text: boolean): string | undefined {
  const parts = [
    ...(styles ? [`${styles} ${styles === 1 ? "style change" : "style changes"}`] : []),
    ...(text ? ["text changed"] : []),
  ];
  const summary = parts.join(" · ");
  return summary ? `${summary[0]?.toUpperCase() ?? ""}${summary.slice(1)}` : undefined;
}

/**
 * The draft's browser annotations as one chip above the message: its count opens a list of
 * them (crop, element, page text, comment) where each can be reopened in the page or removed;
 * its close button removes them all. Markers on the page follow.
 */
export function AnnotationChip(props: {
  /** The thread whose browser holds the markers; none for a new thread's draft. */
  threadId: string | undefined;
  annotations: DraftAnnotationsState;
}) {
  const session = useSessionPort(props.threadId ?? "");
  const { annotations } = props;
  if (!annotations.count) return null;
  const label = annotationCount(annotations.count);
  const remove = (id: string) => {
    annotations.remove(id);
    session?.remove(id);
  };
  return (
    <div className="flex px-3 pt-3">
      <Popover>
        <div className="inline-flex h-8 max-w-full min-w-0 items-center gap-0.5 rounded-md border border-sidebar-border bg-background/50 pr-1 pl-1">
          <PopoverTrigger
            aria-label={`Show ${label}`}
            className="flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-1 text-ui leading-4 text-foreground focus-ring hover:text-foreground aria-expanded:text-foreground"
          >
            <ChatTeardropTextIcon
              aria-hidden
              size={16}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate tabular-nums">{label}</span>
          </PopoverTrigger>
          <IconButton
            icon={XIcon}
            label="Remove all annotations"
            size="sm"
            tooltip={false}
            onClick={() => {
              annotations.clear();
              session?.clear();
            }}
          />
        </div>
        <PopoverContent side="top" align="start" className="w-[min(22rem,calc(100vw-2rem))] p-1">
          <ul aria-label="Annotations" className="max-h-80 overflow-y-auto">
            {annotations.items.map((item) => (
              <Row
                key={item.annotation.id}
                item={item}
                threadId={props.threadId}
                session={session}
                onRemove={remove}
              />
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function Row(props: {
  item: AnnotationItem;
  threadId: string | undefined;
  session: AnnotationSessionPort | undefined;
  onRemove(id: string): void;
}) {
  const { annotation } = props.item;
  const { number, element } = annotation;
  const changes = changeSummary(annotation.styles.length, !!annotation.text);
  // A region lists what it holds; its thumbnail is the area's crop.
  const excerpt =
    annotation.kind === "region" ? regionContents(annotation.region?.elements ?? []) : element.text;
  const editReason = !props.session
    ? "Open the Browser to edit it"
    : props.session.url() !== annotation.url
      ? "Open its page in the Browser to edit it"
      : undefined;
  return (
    <li className="flex items-start gap-2.5 rounded-md p-2">
      <Thumbnail item={props.item} threadId={props.threadId} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <MarkerNumber number={number} />
          <TagBadge tag={badgeFor(annotation.kind, element.tag)} />
        </div>
        {excerpt && (
          <p className="mt-1 line-clamp-2 text-xs wrap-break-word text-muted-foreground">
            {excerpt}
          </p>
        )}
        {annotation.comment && (
          <p className="mt-1 line-clamp-3 text-ui wrap-break-word whitespace-pre-wrap text-foreground">
            {annotation.comment}
          </p>
        )}
        {changes && <p className="mt-1 text-xs text-subtle-foreground">{changes}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton
          icon={PencilSimpleIcon}
          label={`Edit annotation ${number}`}
          tip="Edit in the page"
          size="sm"
          disabled={!!editReason}
          reason={editReason}
          onClick={() => props.session?.edit(annotation.id)}
        />
        <IconButton
          icon={TrashIcon}
          label={`Remove annotation ${number}`}
          tip="Remove"
          size="sm"
          onClick={() => props.onRemove(annotation.id)}
        />
      </div>
    </li>
  );
}

/** The element's or region's crop: this page's own copy while it has one, else the daemon's thumbnail. */
function Thumbnail(props: { item: AnnotationItem; threadId: string | undefined }) {
  const ready = props.item.crop?.ready;
  const source: ImageSource | undefined = props.item.preview
    ? { kind: "url", url: props.item.preview }
    : ready && props.threadId
      ? {
          kind: "attachment",
          threadId: props.threadId,
          sha256: ready.sha256,
          bytes: 0,
          thumbnail: true,
        }
      : undefined;
  const frame = "grid size-10 shrink-0 place-items-center overflow-hidden rounded-sm bg-secondary";
  if (!source)
    return (
      <span aria-hidden className={frame}>
        <ImageIcon size={16} className="text-faint-foreground" />
      </span>
    );
  return (
    <span aria-hidden className={frame}>
      <ImageUrl source={source}>
        {(image) =>
          image.state === "ready" ? (
            <img src={image.url} alt="" draggable={false} className="size-full object-cover" />
          ) : (
            <ImageIcon size={16} className="text-faint-foreground" />
          )
        }
      </ImageUrl>
    </span>
  );
}
