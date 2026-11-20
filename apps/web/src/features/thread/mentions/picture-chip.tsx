import { MentionMark, type MentionPicture } from "./mention-mark.tsx";

/**
 * A chip with its picture (ADR 0198): the same mark and name in the composer and the sent
 * message, its one line of context on hover, and "offline" in words for a device that is.
 */
export function PictureChip(props: {
  name: string;
  picture: MentionPicture;
  detail?: string | undefined;
  offline?: boolean | undefined;
}) {
  return (
    <span
      title={props.detail}
      data-mention-chip=""
      className="inline-flex max-w-full items-baseline gap-1 align-baseline font-medium text-link"
    >
      <span className="grid size-3.5 shrink-0 place-items-center self-center">
        <MentionMark picture={props.picture} size={14} />
      </span>
      <span className="truncate">{props.name}</span>
      {props.offline && <span className="font-normal text-subtle-foreground">offline</span>}
    </span>
  );
}
