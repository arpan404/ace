import { useRef, type KeyboardEvent } from "react";
import { Kbd } from "@/components/ui/kbd.tsx";
import { cn } from "@/lib/cn.ts";
import { paletteScopes, type PaletteScope } from "./arrange.ts";

/** The scope after `scope`, `by` steps along, wrapping round. */
export function stepScope(scope: PaletteScope, by: number): PaletteScope {
  const at = paletteScopes.findIndex((each) => each.id === scope);
  const next = paletteScopes[(at + by + paletteScopes.length) % paletteScopes.length];
  return next?.id ?? scope;
}

/**
 * The palette's tabs over its field: All, Actions, Threads, Chats and Messages as words, the
 * open one on a soft fill. In the field, Tab moves to the next tab and ⇧Tab steps up onto the
 * open tab. On them: ← and → move along, Home and End to the ends; ↓, Enter or Tab go back to
 * the field, and typing goes to the field too; Esc closes the palette, as anywhere in it. A click
 * opens one and leaves the caret in the field.
 */
export function ScopeTabs(props: {
  scope: PaletteScope;
  onScope(scope: PaletteScope): void;
  /** Back to the search field. */
  onLeave(): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const focusOpen = () =>
    requestAnimationFrame(() =>
      list.current?.querySelector<HTMLElement>("[aria-selected=true]")?.focus(),
    );
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number | "first" | "last"> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      Home: "first",
      End: "last",
    };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      const next =
        move === "first"
          ? paletteScopes[0].id
          : move === "last"
            ? (paletteScopes.at(-1)?.id ?? props.scope)
            : stepScope(props.scope, move);
      props.onScope(next);
      focusOpen();
      return;
    }
    if (["ArrowDown", "Enter", "Tab"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      props.onLeave();
      return;
    }
    // A letter typed here is meant for the search: the field takes it.
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey)
      props.onLeave();
  };
  return (
    <div
      ref={list}
      className="flex shrink-0 items-center gap-0.5 px-2 pt-2"
      role="tablist"
      aria-label="Search in"
      onKeyDown={onKeyDown}
    >
      {paletteScopes.map(({ id, label }) => {
        const open = id === props.scope;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={open}
            // Out of the Tab order, so the palette opens with the caret in its field; ⇧Tab in
            // the field brings focus here.
            tabIndex={-1}
            // A click keeps the caret in the field.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onScope(id)}
            className={cn(
              "h-7 cursor-pointer rounded-md px-2.5 text-ui transition-colors duration-(--motion-fast) focus-ring",
              open ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
      <Kbd className="ml-1.5 pointer-coarse:hidden">Tab</Kbd>
    </div>
  );
}

/** Put focus on the open tab of the palette's tab row inside `root`. */
export function focusScopeTabs(root: ParentNode | null | undefined): void {
  root?.querySelector<HTMLElement>('[role="tablist"] [aria-selected="true"]')?.focus();
}
