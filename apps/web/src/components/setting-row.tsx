import { useLocation } from "@tanstack/react-router";
import {
  createContext,
  use,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";

/** Rows inside a grouped section: the group draws the hairlines between them. */
const InCard = createContext(false);

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
      id={props.id}
      ref={row}
      className={cn(
        "@container group/setting transition-colors duration-(--dur-4)",
        !inCard && "border-t first:border-t-0",
        flashing && "bg-accent",
      )}
    >
      <div className={cn("flex min-h-9 items-center gap-3 py-1")}>
        <div className="min-w-0 flex-1">
          {compact && props.description ? (
            <Tip label={props.description}>
              <Title
                {...(props.htmlFor ? { htmlFor: props.htmlFor } : {})}
                id={titleId}
                tabIndex={!props.htmlFor && compact && props.description ? 0 : undefined}
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
              className="truncate text-xs text-muted-foreground"
            >
              {props.description}
            </p>
          )}
        </div>
        {props.children && (
          <div
            className={cn(
              "ml-auto flex min-w-0 max-w-[60%] shrink-0 flex-wrap items-center justify-end gap-2 *:max-w-full",
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
 * A labelled group of rows, with dividers between rows and a quiet heading.
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
    <section id={props.anchor} className="mt-7" aria-labelledby={id}>
      <div className="mb-2 flex items-center gap-2">
        <h3 id={id} className="text-sm font-medium text-muted-foreground">
          {props.label}
        </h3>
        {props.actions && <div className="ml-auto flex items-center gap-1">{props.actions}</div>}
      </div>
      {props.note && <p className="mb-2 text-sm text-muted-foreground">{props.note}</p>}
      <InCard value>
        <div className="divide-y">{props.children}</div>
      </InCard>
    </section>
  );
}
