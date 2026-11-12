import { ImageIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import type { RefObject } from "react";
import { ImageUrl } from "@/components/attachment-bytes.tsx";
import type { ImageSource } from "@/components/attachment-format.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Popover, PopoverContent } from "@/components/ui/popover.tsx";
import { useOpenAfterMount } from "@/lib/pending-open.tsx";
import { changeSummary } from "./annotation-words.ts";
import type { AnnotationItem, DraftAnnotationsState } from "./draft-annotations.ts";
import { MarkerNumber, TagBadge } from "./marker.tsx";
import { badgeFor, regionContents } from "./region-summary.ts";
import type { AnnotationSessionPort } from "./store.ts";

/**
 * The annotation chip's list, as a popover from its count (`annotation-chip.tsx`): each
 * annotation's crop, element, page text and comment, to reopen in the page or remove. Loaded on
 * the chip's first open, warmed while idle with the composer's parts. It mounts closed and opens
 * before the first paint, so it plays its opening transition.
 */
export function AnnotationList(props: {
  threadId: string | undefined;
  annotations: DraftAnnotationsState;
  session: AnnotationSessionPort | undefined;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The chip's count: the list's anchor, and where focus returns when it closes. */
  anchor: RefObject<HTMLButtonElement | null>;
  popup: string;
}) {
  const { annotations, session, anchor } = props;
  const { mounted, open } = useOpenAfterMount(props.open);
  const remove = (id: string) => {
    annotations.remove(id);
    session?.remove(id);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        // A press on the count toggles; the popover's own outside press must not undo it.
        const target = details.event?.target;
        if (!next && target instanceof Node && anchor.current?.contains(target)) return;
        props.onOpenChange(next);
      }}
    >
      {mounted && (
        <PopoverContent
          id={props.popup}
          anchor={anchor}
          finalFocus={anchor}
          side="top"
          align="start"
          className="w-[min(22rem,calc(100vw-2rem))] p-1"
        >
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
      )}
    </Popover>
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
