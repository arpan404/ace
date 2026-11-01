import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import type { ComponentProps, ReactNode } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { SearchField } from "@/components/search-field.tsx";
import { cn } from "@/lib/cn.ts";

/*
 * The pieces every place's panel is built from (Threads, Chats, Skills, Automations, Settings,
 * Code review): one title row, one search field, one section label and one row. A panel never styles
 * these itself, so the places stay alike.
 */

/** A bare 32px icon button in a panel's title row (New chat, Add a skill). */
export const panelIconButton =
  "relative grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit touch-hit-lg hover:bg-hover hover:text-foreground aria-expanded:bg-active aria-expanded:text-foreground";

/** A panel title's type: the place's name, or the words of a title that is also a menu. */
export const panelTitleText =
  "min-w-0 truncate text-lg font-semibold tracking-title text-foreground";

/**
 * The panel's title row, under the window's top bar and level with the rail's first place: the
 * title (`PanelTitle`, or a filter menu in its place), then the place's 32px actions.
 */
export function PanelTitleRow(props: { children: ReactNode; className?: string | undefined }) {
  return (
    <div
      data-slot="panel-top"
      className={cn("flex h-(--header-h) shrink-0 items-center gap-1 pr-2.5 pl-2", props.className)}
    >
      {props.children}
    </div>
  );
}

/** A plain panel title ("Chats", "Skills"), inset to line up with a filter menu's words. */
export function PanelTitle(props: { children: ReactNode }) {
  return <h2 className={cn("flex-1 pl-2", panelTitleText)}>{props.children}</h2>;
}

/** The search field under a panel's title row. */
export function PanelSearch(props: ComponentProps<typeof SearchField>) {
  return (
    <div className="shrink-0 px-2 pb-1">
      <SearchField {...props} />
    </div>
  );
}

/** One row's line: `--row-height`, inset, rounded; the fills come with `panelRow`. */
export const panelRowLine =
  "flex h-(--row-height) w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-md transition-colors duration-(--motion-fast) focus-ring-inset";

const panelRowClass = cn(
  panelRowLine,
  "text-foreground hover:bg-hover aria-[current=page]:bg-active data-[status=active]:bg-active",
);

/**
 * A panel row's props for its link or button: the line, the hover fill and the current row's
 * fill, and `data-panel-row`, which marks it as one of the panel's rows.
 */
export function panelRow(className?: string): { "data-panel-row": ""; className: string } {
  return { "data-panel-row": "", className: cn(panelRowClass, className) };
}

/** A panel row's inside: its glyph, its title (one line) and what trails it. */
export function PanelRowBody(props: {
  icon?: IconGlyph | undefined;
  /** Room the width of a glyph instead of one, for a row inside a group. */
  indent?: boolean;
  title: ReactNode;
  /** Muted words, as a paused or settled row's. */
  quiet?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <>
      {props.icon ? (
        <Icon icon={props.icon} className="shrink-0 text-muted-foreground" />
      ) : (
        props.indent && <span aria-hidden className="w-4 shrink-0" />
      )}
      <span
        data-view-row-title=""
        className={cn("min-w-0 flex-1 truncate", props.quiet && "text-muted-foreground")}
      >
        {props.title}
      </span>
      {props.trailing}
    </>
  );
}

/** A section label's line in a panel ("Pinned", "Projects", "Upcoming"). */
export const panelLabel =
  "flex h-7 w-full items-center gap-1.5 px-2.5 text-ui text-muted-foreground";

/** The space above a section label: little for the list's first, more between sections. */
export const panelLabelGap = (first: boolean) => (first ? "mt-1" : "mt-5");

/** A section of a panel's list: its label, then its rows. */
export function PanelSection(props: { label: string; children: ReactNode }) {
  return (
    <section aria-label={props.label} className="mt-5 first:mt-1">
      <h3 className={panelLabel}>{props.label}</h3>
      <ul className="flex flex-col gap-px">{props.children}</ul>
    </section>
  );
}

/** A section label that folds its rows away: a caret, then the words. */
export function PanelDisclosure(
  props: Omit<ComponentProps<"button">, "type"> & { open: boolean; children: ReactNode },
) {
  const { open, children, className, ...rest } = props;
  return (
    <button
      type="button"
      aria-expanded={open}
      className={cn(
        panelRowLine,
        "text-ui text-muted-foreground hover:bg-hover hover:text-foreground",
        className,
      )}
      {...rest}
    >
      {open ? (
        <CaretDownIcon aria-hidden size={12} className="shrink-0" />
      ) : (
        <CaretRightIcon aria-hidden size={12} className="shrink-0" />
      )}
      {children}
    </button>
  );
}
