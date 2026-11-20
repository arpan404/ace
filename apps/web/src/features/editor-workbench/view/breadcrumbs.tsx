import { Fragment } from "react";

/**
 * The 26px line under a strip: the file's folders and name in mono. The folders give way first
 * (they truncate from their start), so the file's name always shows whole (spec 39). Sibling
 * menus per segment arrive with the explorer's listing (W4).
 */
export function Breadcrumbs(props: { path: string | undefined }) {
  if (props.path === undefined) return <div aria-hidden className="h-[26px] shrink-0" />;
  const segments = props.path.split("/");
  const name = segments.pop() ?? props.path;
  return (
    <nav
      aria-label="File path"
      className="flex h-[26px] shrink-0 items-center gap-1.5 px-3.5 font-mono text-xs whitespace-nowrap text-subtle-foreground"
    >
      {segments.length > 0 && (
        // rtl clips the start, keeping the folders nearest the file; the bdi keeps their order.
        <span className="min-w-0 truncate [direction:rtl]">
          <bdi className="[direction:ltr]">
            {segments.map((segment, index) => (
              <Fragment key={segments.slice(0, index + 1).join("/")}>
                {segment}
                <span aria-hidden className="px-1.5 text-faint-foreground">
                  ›
                </span>
              </Fragment>
            ))}
          </bdi>
        </span>
      )}
      <span aria-current="page" className="shrink-0 text-muted-foreground">
        {name}
      </span>
    </nav>
  );
}
