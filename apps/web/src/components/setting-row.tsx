import { useLocation } from "@tanstack/react-router";
import {
  use,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { useRender } from "@base-ui/react/use-render";
import { CaretRightIcon } from "@phosphor-icons/react";
import { InCard } from "@/components/ui/surface-context.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * Marks the children that inset themselves inside a card (rows, notes, footers, lists). Anything
 * else a page puts in a card gets a margin inset, so a button keeps its own padding.
 */
const slot = { "data-setting-slot": "" } as const;

/**
 * Settings-style row: title and description on the left, the control on the right. Hairlines
 * separate rows. Labels and controls keep the same edges at narrow widths. `id` makes the row
 * a deep link: `/settings/general#threads.useWorktree` scrolls to it and flashes it.
 */
export function SettingRow(props: {
  title: ReactNode;
  compact?: boolean;
  description?: ReactNode;
  children?: ReactNode;
  /** Associates the title with a control for assistive tech. */
  htmlFor?: string | undefined;
  /** Keep the control beside the text at every width (a switch, a short button). */
  inline?: boolean;
  /** A single 36px row; its description is shown on hover or focus. */
  density?: "default" | "compact";
  /** The row's anchor, from the settings index (`settingsIndex`). */
  id?: string;
}) {
  const inCard = use(InCard);
  const compact = props.compact || props.density === "compact";
  const titleId = useId();
  const hintId = useId();
  const Title = props.htmlFor ? "label" : "div";
  const row = useRef<HTMLDivElement>(null);
  const flashing = useHashFlash(props.id, row);
  return (
    <div
      {...slot}
      id={props.id}
      ref={row}
      data-flash={flashing || undefined}
      className={cn(
        "@container group/setting transition-colors duration-(--motion-slow)",
        inCard ? "px-4" : "border-t first:border-t-0",
        flashing && "bg-accent",
      )}
    >
      <div
        className={cn(
          "flex min-h-(--setting-row-height) items-center gap-4 py-(--setting-row-y)",
          !props.inline && "@max-[440px]:flex-col @max-[440px]:items-stretch",
        )}
      >
        <div className="min-w-0 flex-1">
          {compact && props.description ? (
            <Tip label={props.description}>
              <Title
                {...(props.htmlFor ? { htmlFor: props.htmlFor } : {})}
                id={titleId}
                tabIndex={0}
                aria-describedby={hintId}
                className="block rounded-sm text-ui focus-ring"
              >
                {props.title}
              </Title>
            </Tip>
          ) : (
            <Title
              {...(props.htmlFor ? { htmlFor: props.htmlFor } : {})}
              id={titleId}
              tabIndex={!props.htmlFor && compact && props.description ? 0 : undefined}
              className="block rounded-sm text-ui focus-ring"
            >
              {props.title}
            </Title>
          )}
          {props.description && compact && (
            <span id={hintId} className="sr-only">
              {props.description}
            </span>
          )}
          {props.description && !compact && (
            <p
              id={hintId}
              title={typeof props.description === "string" ? props.description : undefined}
              className="mt-0.5 text-xs text-muted-foreground"
            >
              {props.description}
            </p>
          )}
        </div>
        {props.children && (
          <div
            className={cn(
              "ml-auto flex min-w-0 max-w-[60%] shrink-0 flex-wrap items-center justify-end gap-2 *:max-w-full",
              !props.inline &&
                "@max-[440px]:ml-0 @max-[440px]:max-w-full @max-[440px]:justify-start",
            )}
          >
            {props.children}
          </div>
        )}
      </div>
    </div>
  );
}

/** One-line device or machine row; hover or focus its name to read the details. */
export function SettingSummaryRow(props: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <SettingRow title={props.title} description={props.description} compact inline>
      {props.children}
    </SettingRow>
  );
}

/** Scroll a row into view and flash it once when the location's hash names it. */
function useHashFlash(id: string | undefined, ref: RefObject<HTMLElement | null>): boolean {
  const hash = useLocation({ select: (location) => location.hash });
  const [on, setOn] = useState(false);
  const target = id !== undefined && hash === id;
  useEffect(() => {
    if (!target) return;
    ref.current?.scrollIntoView?.({ block: "center" });
    const start = requestAnimationFrame(() => setOn(true));
    const stop = setTimeout(() => setOn(false), 1_200);
    return () => {
      cancelAnimationFrame(start);
      clearTimeout(stop);
    };
  }, [target, ref]);
  return target && on;
}

/** Ownership metadata retained for settings callers; section chrome is scope-free. */
export type SettingScope = "daemon" | "device" | "computer";

/**
 * A titled group of rows on a subtle card, hairlines between rows (docs/design/visual-language.md,
 * "Settings").
 */
export function SettingSection(props: {
  label: string;
  anchor?: string;
  children: ReactNode;
  card?: boolean;
  scope?: SettingScope | undefined;
  /** A line under the heading, e.g. why the values aren't shown yet. */
  note?: ReactNode;
  /** Small buttons at the end of the heading row ("Check again"). */
  actions?: ReactNode;
}) {
  const id = useId();
  return (
    <section id={props.anchor} className="mt-8" aria-labelledby={id}>
      <div className="mb-2 flex min-h-7 items-center gap-2 px-1">
        <h3 id={id} className="text-ui font-medium text-foreground">
          {props.label}
        </h3>
        {props.actions && <div className="ml-auto flex items-center gap-1">{props.actions}</div>}
      </div>
      {props.note && <p className="mb-2 px-1 text-sm text-muted-foreground">{props.note}</p>}
      <SettingCard>{props.children}</SettingCard>
    </section>
  );
}

/**
 * Rows grouped on a subtle card with hairlines between them. Put rows (`SettingRow`), prose
 * (`SettingNote`), actions (`SettingFooter`), lists of rows (`SettingList`) and disclosures
 * (`SettingDisclosure`) in it; each insets itself to the card's one left edge. `SettingSection`
 * adds a title; use this alone for rows that head a page without one.
 */
export function SettingCard(props: { children: ReactNode; className?: string }) {
  return (
    <InCard value>
      <div
        className={cn(
          "divide-y divide-border-soft rounded-lg border border-border-soft bg-card [&>:not([data-setting-slot])]:mx-4",
          props.className,
        )}
      >
        {props.children}
      </div>
    </InCard>
  );
}

/** Prose inside a card (a status line, what a group does), inset like a row's text. */
export function SettingNote({ className, ...props }: ComponentProps<"p">) {
  return (
    <p {...slot} className={cn("px-4 py-3 text-sm text-muted-foreground", className)} {...props} />
  );
}

/** A card's actions, one row tall, at the end of the row like a row's control. */
export function SettingFooter(props: { children: ReactNode; className?: string }) {
  return (
    <div
      {...slot}
      className={cn(
        "flex min-h-(--setting-row-height) flex-wrap items-center justify-end gap-2 px-4 py-(--setting-row-y)",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

/** A list of rows inside a card; its rows inset themselves, the list adds the hairlines. */
export function SettingList({ className, ...props }: ComponentProps<"ul">) {
  return <ul {...slot} className={cn("divide-y divide-border-soft", className)} {...props} />;
}

/** One row of a `SettingList`: the row's height and inset, whatever it holds. */
export function SettingListItem({ className, id, ref, ...props }: ComponentProps<"li">) {
  const own = useRef<HTMLLIElement>(null);
  const flashing = useHashFlash(id, own);
  // useRender joins the row's own ref (for the flash) with a caller's.
  return useRender({
    defaultTagName: "li",
    ref: ref ? [own, ref] : own,
    props: {
      ...props,
      id,
      "data-flash": flashing || undefined,
      className: cn(
        "flex min-h-(--setting-row-height) items-center gap-2 px-4 py-(--setting-row-y) transition-colors duration-(--motion-slow)",
        flashing && "bg-accent",
        className,
      ),
    },
  });
}

/**
 * A row that is itself the action ("+ Add account", "+ Pair a device"): a full-width button whose
 * label starts on the row text's edge. Works as a card child or inside a `SettingList`. Like a
 * row, a link naming its `id` scrolls to it and flashes it.
 */
export function SettingAction({
  className,
  id,
  type = "button",
  ref,
  ...props
}: ComponentProps<"button">) {
  const own = useRef<HTMLButtonElement>(null);
  const flashing = useHashFlash(id, own);
  return useRender({
    defaultTagName: "button",
    ref: ref ? [own, ref] : own,
    props: {
      ...props,
      ...slot,
      id,
      type,
      "data-flash": flashing || undefined,
      className: cn(
        "flex min-h-(--setting-row-height) w-full items-center gap-2 px-4 text-left text-ui font-medium text-muted-foreground transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-fill hover:text-foreground disabled:opacity-50",
        flashing && "bg-accent",
        className,
      ),
    },
  });
}

/**
 * A group of rows behind a one-row disclosure, with a caret instead of the browser's triangle.
 * Inside a card it is one row of the card; its content sits under it.
 */
export function SettingDisclosure(props: {
  title: ReactNode;
  open?: boolean | undefined;
  onToggle?(open: boolean): void;
  className?: string;
  children: ReactNode;
}) {
  const inCard = use(InCard);
  return (
    <details
      {...slot}
      open={props.open || undefined}
      data-setting-surface={inCard ? "card" : "plain"}
      onToggle={(event) => props.onToggle?.(event.currentTarget.open)}
      className={cn("group/disclosure", props.className)}
    >
      <summary
        className={cn(
          "flex cursor-default list-none items-center gap-2 text-ui [&::-webkit-details-marker]:hidden",
          inCard
            ? "min-h-(--setting-row-height) px-4 focus-ring-inset"
            : "h-8 w-fit rounded-md pr-2 text-muted-foreground focus-ring hover:text-foreground",
        )}
      >
        <CaretRightIcon
          aria-hidden
          size={12}
          className="shrink-0 text-muted-foreground transition-transform duration-(--motion-fast) group-open/disclosure:rotate-90"
        />
        {props.title}
      </summary>
      {/* Its rows keep the card's hairlines between them. */}
      <div className={cn(inCard && "divide-y divide-border-soft border-t border-border-soft")}>
        {props.children}
      </div>
    </details>
  );
}
