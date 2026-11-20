import type { EditorTab } from "@ace/ui-core/editor-workbench";
import { cn } from "@/lib/cn.ts";

/*
 * ⌃Tab (spec 26): a solid list of the focused group's editors, most recently used first. Holding
 * ⌃ and tapping Tab moves down, ⌃⇧Tab up; letting go of ⌃ opens the one marked. The panel owns
 * the keys; this only draws.
 */

/** Where ⌃Tab lands from `index`, wrapping, among `count` editors. */
export const stepRecent = (index: number, delta: 1 | -1, count: number) =>
  count === 0 ? 0 : (((index + delta) % count) + count) % count;

export function RecentEditors(props: {
  tabs: readonly EditorTab[];
  index: number;
  onPick(path: string): void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-12 z-[5] flex justify-center">
      <ul
        role="listbox"
        aria-label="Recent editors"
        className="ace-floating-solid pointer-events-auto flex max-h-80 w-[min(420px,90%)] flex-col overflow-y-auto rounded-md border border-border p-1 shadow-lg"
      >
        {props.tabs.map((tab, index) => (
          <li
            key={tab.path}
            role="option"
            aria-selected={index === props.index}
            onPointerDown={(event) => {
              event.preventDefault();
              props.onPick(tab.path);
            }}
            className={cn(
              "flex h-7 items-center gap-2 rounded-sm px-2 text-ui",
              index === props.index ? "bg-active text-foreground" : "text-muted-foreground",
            )}
          >
            <span className={cn("shrink-0", tab.preview && "italic")}>
              {tab.path.split("/").at(-1)}
            </span>
            <span className="min-w-0 truncate text-xs text-subtle-foreground">
              {tab.path.split("/").slice(0, -1).join("/")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
