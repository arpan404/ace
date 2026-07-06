import { isValidElement, type ReactElement, type ReactNode, useEffect, useState } from "react";
import { Undo2Icon } from "lucide-react";

import { formatRelativeTime } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import type { ComponentProps } from "react";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import { SidebarTrigger } from "../ui/sidebar";
import {
  SETTINGS_COMPACT_CONTROL_CLASS,
  SETTINGS_CONTENT_GUTTER_CLASS,
  SETTINGS_CONTENT_MAX_WIDTH_CLASS,
  SETTINGS_CONTENT_TOP_PADDING_CLASS,
  SETTINGS_CONTENT_BOTTOM_PADDING_CLASS,
  SETTINGS_CONTROL_SURFACE_CLASS_NAMES,
  SETTINGS_FIELD_CLASS,
  SETTINGS_FIELD_CONTROL_CLASS,
  SETTINGS_SELECT_TRIGGER_CLASS,
  SETTINGS_GROUP_CLASS_NAME,
  SETTINGS_HEADER_PAGE_CLASS,
  SETTINGS_HEADER_ROOT_CLASS,
  SETTINGS_HEADER_SEPARATOR_CLASS,
  SETTINGS_INSET_PANEL_CLASS,
  SETTINGS_PAGE_DESCRIPTION_CLASS,
  SETTINGS_PAGE_TITLE_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_DESCRIPTION_CLASS,
  SETTINGS_ROW_STATUS_CLASS,
  SETTINGS_ROW_TITLE_CLASS,
  SETTINGS_SECTION_DESCRIPTION_CLASS,
  SETTINGS_SECTION_CARD_BODY_CLASS,
  SETTINGS_SECTION_CARD_CLASS,
  SETTINGS_SECTION_FRAME_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from "./settingsUi";

type SettingsInputProps = ComponentProps<typeof Input>;

export function SettingsInput({ className, ...props }: SettingsInputProps) {
  return <Input className={cn(SETTINGS_FIELD_CLASS, className)} {...props} />;
}

export { SETTINGS_GROUP_CLASS_NAME } from "./settingsUi";
export const SETTINGS_ROW_INSET_CLASS_NAME = SETTINGS_ROW_CLASS;
export const SETTINGS_LIST_ROW_CLASS_NAME = SETTINGS_ROW_CLASS;

function useRelativeTimeTick(intervalMs = 1_000) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}

export function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = lastCheckedAt ? formatRelativeTime(lastCheckedAt) : null;

  if (!lastCheckedRelative) {
    return null;
  }

  return (
    <span className={SETTINGS_ROW_STATUS_CLASS}>
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

function isCompactControl(control: ReactNode): control is ReactElement {
  if (!isValidElement(control)) {
    return false;
  }
  return control.type === Switch || control.type === Select;
}

export function SettingsPageHeader({
  pageLabel,
  description,
  action,
  showSidebarTrigger = false,
  className,
}: {
  pageLabel: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  showSidebarTrigger?: boolean;
  className?: string;
}) {
  return (
    <header className={cn("mb-8 min-w-0", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          {showSidebarTrigger ? <SidebarTrigger className="mt-px shrink-0" /> : null}
          <div className="min-w-0">
            <h1 className={SETTINGS_PAGE_TITLE_CLASS}>
              <span className={SETTINGS_HEADER_ROOT_CLASS}>Settings</span>
              <span className={SETTINGS_HEADER_SEPARATOR_CLASS} aria-hidden="true">
                |
              </span>
              <span className={SETTINGS_HEADER_PAGE_CLASS}>{pageLabel}</span>
            </h1>
            {description ? <p className={SETTINGS_PAGE_DESCRIPTION_CLASS}>{description}</p> : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </header>
  );
}

export function SettingsSection({
  title,
  description,
  headerAction,
  contentClassName,
  bodyClassName,
  framed = true,
  children,
}: {
  title: string;
  description?: ReactNode;
  headerAction?: ReactNode;
  contentClassName?: string;
  bodyClassName?: string;
  /** Wrap rows in a section card. Default on; use false for self-contained panels. */
  framed?: boolean;
  children: ReactNode;
}) {
  const body = (
    <div
      className={
        framed
          ? (bodyClassName ?? SETTINGS_SECTION_CARD_BODY_CLASS)
          : cn(SETTINGS_SECTION_FRAME_CLASS, SETTINGS_GROUP_CLASS_NAME)
      }
    >
      {children}
    </div>
  );

  return (
    <section className={cn("min-w-0", contentClassName)}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={SETTINGS_SECTION_TITLE_CLASS}>{title}</h2>
          {description ? <p className={SETTINGS_SECTION_DESCRIPTION_CLASS}>{description}</p> : null}
        </div>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>
      {framed ? <div className={SETTINGS_SECTION_CARD_CLASS}>{body}</div> : body}
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  controlClassName,
  layout,
  tone = "default",
  children,
}: {
  title: ReactNode;
  description?: string;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  controlClassName?: string;
  layout?: "compact" | "field";
  tone?: "default" | "warning" | "danger";
  children?: ReactNode;
}) {
  const useCompactLayout = layout ?? (control && !children ? isCompactControl(control) : false);

  const label = (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className={SETTINGS_ROW_TITLE_CLASS}>{title}</span>
        {resetAction}
      </div>
      {description ? <p className={SETTINGS_ROW_DESCRIPTION_CLASS}>{description}</p> : null}
      {status ? <div className={SETTINGS_ROW_STATUS_CLASS}>{status}</div> : null}
    </div>
  );

  return (
    <div
      className={cn(
        SETTINGS_ROW_CLASS,
        tone === "warning" && "bg-warning/[0.04]",
        tone === "danger" && "bg-destructive/[0.04]",
      )}
    >
      {useCompactLayout && control ? (
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
          {label}
          <div
            className={cn(
              SETTINGS_COMPACT_CONTROL_CLASS,
              "flex shrink-0 items-center sm:justify-end",
              controlClassName,
            )}
          >
            {control}
          </div>
        </div>
      ) : (
        <div className="space-y-2.5">
          {label}
          {control ? (
            <div className={cn(SETTINGS_FIELD_CONTROL_CLASS, controlClassName)}>{control}</div>
          ) : null}
        </div>
      )}
      {children ? <div className="mt-3 min-w-0">{children}</div> : null}
    </div>
  );
}

export function SettingsChoiceGroup<TValue extends string>({
  label,
  options,
  value,
  onValueChange,
  className,
}: {
  label: string;
  options: readonly {
    value: TValue;
    label: ReactNode;
    description?: ReactNode;
  }[];
  value: TValue;
  onValueChange: (value: TValue) => void;
  className?: string;
}) {
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue !== null) {
          onValueChange(nextValue as TValue);
        }
      }}
    >
      <SelectTrigger
        size="default"
        className={cn(SETTINGS_SELECT_TRIGGER_CLASS, className)}
        aria-label={label}
      >
        <SelectValue>
          <span className="min-w-0 truncate">{selectedOption?.label}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="min-w-0">
              <span className="block truncate text-sm">{option.label}</span>
              {option.description ? (
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  {option.description}
                </span>
              ) : null}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Compact pill-style segmented control (e.g. Bottom/Right, System/On/Off). Interactive
 * replacement for a two/three-way select where the options fit inline.
 */
export function SettingsSegmentedControl<TValue extends string>({
  options,
  value,
  onValueChange,
  ariaLabel,
  className,
}: {
  options: readonly { value: TValue; label: ReactNode }[];
  value: TValue;
  onValueChange: (value: TValue) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-[var(--control-radius)] border border-border/55 bg-muted/45 p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "rounded-[calc(var(--control-radius)-2px)] px-2.5 py-1 text-xs font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground/90",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Big card radio group (e.g. "For coding" / "For everyday work") with an icon, title,
 * and description. The expressive, interactive way to present a small mutually-exclusive
 * choice that benefits from explanation.
 */
export function SettingsCardChoice<TValue extends string>({
  options,
  value,
  onValueChange,
  ariaLabel,
  columns = 2,
  className,
}: {
  options: readonly {
    value: TValue;
    label: ReactNode;
    description?: ReactNode;
    icon?: ReactNode;
  }[];
  value: TValue;
  onValueChange: (value: TValue) => void;
  ariaLabel: string;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "grid gap-3",
        columns === 3 ? "sm:grid-cols-3" : columns === 2 ? "sm:grid-cols-2" : "grid-cols-1",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "group/card relative flex items-start gap-3 rounded-[var(--panel-radius)] border p-3.5 text-left transition-[border-color,background-color,box-shadow] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              active
                ? "border-primary/55 bg-primary/[0.06] ring-1 ring-primary/15"
                : "border-border/55 bg-card/40 hover:border-border hover:bg-accent/40",
            )}
          >
            {option.icon ? (
              <span
                className={cn(
                  "mt-px shrink-0 transition-colors [&_svg]:size-4",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                {option.icon}
              </span>
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-foreground">{option.label}</span>
              {option.description ? (
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  {option.description}
                </span>
              ) : null}
            </span>
            <span
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                active ? "border-primary bg-primary" : "border-border/70 bg-transparent",
              )}
              aria-hidden="true"
            >
              {active ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Labeled slider (shadcn/Base UI) with a live value read-out (e.g. Contrast). */
export function SettingsSlider({
  value,
  min,
  max,
  step = 1,
  onValueChange,
  ariaLabel,
  formatValue,
  className,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onValueChange: (value: number) => void;
  ariaLabel: string;
  formatValue?: (value: number) => ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-40 items-center gap-3", className)}>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        aria-label={ariaLabel}
        onValueChange={(next) => onValueChange(Array.isArray(next) ? (next[0] ?? value) : next)}
        className="min-w-24"
      />
      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatValue ? formatValue(value) : value}
      </span>
    </div>
  );
}

export function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
      aria-label={`Reset ${label} to default`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Undo2Icon className="size-3" />
      Reset
    </Button>
  );
}

export function SettingsPageContainer({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto",
        SETTINGS_CONTENT_TOP_PADDING_CLASS,
        SETTINGS_CONTENT_BOTTOM_PADDING_CLASS,
      )}
    >
      <div
        className={cn(
          "mx-auto w-full",
          SETTINGS_CONTENT_MAX_WIDTH_CLASS,
          SETTINGS_CONTENT_GUTTER_CLASS,
          ...SETTINGS_CONTROL_SURFACE_CLASS_NAMES,
        )}
      >
        <div className="space-y-8">{children}</div>
      </div>
    </div>
  );
}

export function SettingsInsetPanel({
  children,
  className,
  muted = false,
}: {
  children: ReactNode;
  className?: string;
  muted?: boolean;
}) {
  return (
    <div className={cn(SETTINGS_INSET_PANEL_CLASS, muted && "bg-muted/10", className)}>
      {children}
    </div>
  );
}
