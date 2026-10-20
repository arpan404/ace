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
  return (
    <span className="rounded-xs bg-secondary px-1 font-mono text-2xs leading-4 text-muted-foreground">
      {props.tag.toLowerCase()}
    </span>
  );
}
