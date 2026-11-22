import { CaretRightIcon } from "@ace/icons";
import { Fragment, type ReactNode } from "react";

/** Where the trail starts before the editor has said where its text starts. */
const defaultInset = 12;

/**
 * The 26px line under a strip: the file's folders and name in mono, starting where the code's
 * text starts so the two read as one column. The folders give way first (they truncate from
 * their start), so the file's name always shows whole (spec 39). Sibling menus per segment
 * arrive with the explorer's listing (W4).
 */
export function Breadcrumbs(props: {
  path: string | undefined;
  /** The editor's text column, in px from the group's left edge. */
  textStart?: number | undefined;
  /** At the line's right end: Markdown's Preview / Source choice (spec 40). */
  end?: ReactNode;
}) {
  if (props.path === undefined) return <div aria-hidden className="h-[26px] shrink-0" />;
  const segments = props.path.split("/");
  const name = segments.pop() ?? props.path;
  return (
    <div className="flex h-[26px] shrink-0 items-center gap-2 pr-1.5">
      <nav
        aria-label="File path"
        style={{ paddingLeft: props.textStart ?? defaultInset }}
        className="flex min-w-0 flex-1 items-center gap-1 pr-3 font-mono text-xs whitespace-nowrap text-subtle-foreground"
      >
        {segments.length > 0 && (
          // rtl clips the start, keeping the folders nearest the file; the bdi keeps their order.
          <span className="min-w-0 truncate [direction:rtl]">
            <bdi className="[direction:ltr]">
              {segments.map((segment, index) => (
                <Fragment key={segments.slice(0, index + 1).join("/")}>
                  {segment}
                  <CaretRightIcon
                    aria-hidden
                    size={10}
                    className="mx-1 inline-block align-[-1px] text-faint-foreground"
                  />
                </Fragment>
              ))}
            </bdi>
          </span>
        )}
        <span aria-current="page" className="shrink-0 text-foreground">
          {name}
        </span>
      </nav>
      {props.end}
    </div>
  );
}
