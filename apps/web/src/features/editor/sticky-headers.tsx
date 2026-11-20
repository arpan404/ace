/**
 * The pinned headers of sticky scroll, over the top of the text: each one's line number and text,
 * scrolled sideways with the text. Picking one puts the caret on it.
 */
export function StickyHeaders(props: {
  lines: readonly number[];
  lineAt: (line: number) => string;
  gutter: number;
  lineHeight: number;
  scrollLeft: number;
  onPick(line: number): void;
}) {
  if (props.lines.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Current scope"
      data-sticky-headers
      className="absolute inset-x-0 top-0 z-[2] overflow-hidden border-b border-border bg-background"
    >
      {props.lines.map((line) => (
        <button
          key={line}
          type="button"
          tabIndex={-1}
          data-sticky-line={line}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => props.onPick(line)}
          className="flex w-full cursor-pointer items-center text-left font-mono text-ui hover:bg-foreground/5"
          style={{ height: props.lineHeight, lineHeight: `${props.lineHeight}px` }}
        >
          <span
            aria-hidden
            style={{ width: props.gutter }}
            className="shrink-0 pr-4 text-right text-subtle-foreground tabular-nums"
          >
            {line + 1}
          </span>
          <span
            className="min-w-0 whitespace-pre text-foreground"
            style={{ transform: `translateX(${-props.scrollLeft}px)` }}
          >
            {props.lineAt(line)}
          </span>
        </button>
      ))}
    </div>
  );
}
