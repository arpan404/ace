/** A marker's number as the page draws it: a small accent disc. */
export function MarkerNumber(props: { number: number }) {
  return (
    <span className="grid size-4 shrink-0 place-items-center rounded-full bg-tint text-2xs leading-none font-medium text-tint-foreground tabular-nums">
      {props.number}
    </span>
  );
}

/** The annotated element's tag, as code. */
export function TagBadge(props: { tag: string }) {
  return <PlaceBadge text={props.tag.toLowerCase()} />;
}

/** Where an annotation is, as code: a tag, a file and its lines. */
export function PlaceBadge(props: { text: string }) {
  return (
    <span className="min-w-0 truncate rounded-xs bg-secondary px-1 font-mono text-2xs leading-4 text-muted-foreground">
      {props.text}
    </span>
  );
}
