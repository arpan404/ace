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
 * separate rows. Below 30rem of row width the control drops under the text and wide
 * controls take the full width, unless `inline` (switches, small buttons). `id` makes the row
 * a deep link: `/settings/general#threads.useWorktree` scrolls to it and flashes it.
 */
export function SettingRow(props: {
  title: ReactNode;
  compact?: boolean;
  description?: ReactNode;
  children?: ReactNode;
  /** Associates the title with a control for assistive tech. */
  htmlFor?: string;
  /** Keep the control beside the text at every width (a switch, a short button). */
  inline?: boolean;
  /** A single 36px row; its description is shown on hover or focus. */
  density?: "default" | "compact";
  /** The row's anchor, from the settings index (`settingsIndex`). */
  id?: string;
}) {
  const inCard = use(InCard);
  const compact = props.compact || props.density === "compact";
  const Title = props.htmlFor ? "label" : "div";
  const row = useRef<HTMLDivElement>(null);
  const flashing = useHashFlash(props.id, row);
  return (
    <div
      id={props.id}
      ref={row}
      className={cn(
        "@container transition-colors duration-(--dur-4)",
        !inCard && "border-t first:border-t-0",
        flashing && "bg-accent",
      )}
    >
      <div
        className={cn(
          compact ? "flex min-h-9 items-center gap-4 py-1" : "flex gap-4 py-3.5 compact:py-2.5",
          props.inline || compact
            ? "items-center"
            : "flex-col items-stretch gap-2.5 @[30rem]:flex-row @[30rem]:items-center @[30rem]:gap-4",
        )}
      >
        <div className="min-w-0 flex-1">
          {compact && props.description ? (
            <Tip label={props.description}>
              <Title
                {...(props.htmlFor ? { htmlFor: props.htmlFor } : {})}
                className="block text-ui font-medium"
              >
                {props.title}
              </Title>
            </Tip>
          ) : (
            <Title
              {...(props.htmlFor ? { htmlFor: props.htmlFor } : {})}
              className="block text-ui font-medium"
            >
              {props.title}
            </Title>
          )}
          {props.description && !compact && (
            <p className="mt-0.5 text-sm leading-[1.4] text-muted-foreground">
              {props.description}
            </p>
          )}
        </div>
        {props.children && (
          <div
            className={cn(
              "flex shrink-0 items-center gap-2",
              props.inline || compact
                ? "ml-auto"
                : "*:flex-1 @[30rem]:ml-auto @[30rem]:*:flex-none",
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
    <div className="flex h-9 items-center gap-3 text-ui">
      <Tip label={props.description}>
        <span tabIndex={0} className="min-w-0 flex-1 truncate rounded-xs focus-ring">
          {props.title}
        </span>
      </Tip>
      {props.children}
    </div>
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

/** Where a section's settings are kept, shown beside its heading. */
export type SettingScope = "daemon" | "device" | "computer";

const scopes: Record<SettingScope, { label: string; tip: string }> = {
  daemon: {
    label: "All devices",
    tip: "Every paired device follows these settings",
  },
  device: { label: "This device", tip: "Kept in this browser or app only" },
  computer: { label: "This computer", tip: "Kept by the desktop app on this computer" },
};

/**
 * A labelled group of rows. `scope` says where its settings live.
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
  const scope = props.scope ? scopes[props.scope] : undefined;
  return (
    <section id={props.anchor} className="mt-7" aria-labelledby={id}>
      <div className="mb-2 flex items-center gap-2">
        <h3 id={id} className="text-sm font-medium text-muted-foreground">
          {props.label}
        </h3>
        {scope && (
          <Tip label={scope.tip}>
            <span tabIndex={0} className="rounded-xs text-xs text-subtle-foreground focus-ring">
              {scope.label}
            </span>
          </Tip>
        )}
        {props.actions && <div className="ml-auto flex items-center gap-1">{props.actions}</div>}
      </div>
      {props.note && <p className="mb-2 text-sm text-muted-foreground">{props.note}</p>}
      {props.card ? (
        <InCard value>
          <div className="divide-y">{props.children}</div>
        </InCard>
      ) : (
        props.children
      )}
    </section>
  );
}
