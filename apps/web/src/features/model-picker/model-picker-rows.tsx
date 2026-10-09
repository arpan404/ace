import { Button } from "@/components/ui/button.tsx";
import { useRefreshModels } from "./use-refresh-models.ts";
import type { ProviderKind } from "@ace/protocol";
import type { ModelProblem, PickerGroup, PickerModel } from "@ace/ui-core";
import { providerNames, freeModelMarker } from "@ace/ui-core";
import {
  CaretRightIcon,
  CheckIcon,
  MagnifyingGlassIcon,
  StarIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Kbd } from "@/components/ui/kbd.tsx";
import { menuItem, menuLabel } from "@/components/ui/menu-styles.ts";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { useAccountViews } from "@/lib/account-views.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { titleWhenClipped } from "@/lib/clipped-title.ts";
import { cn } from "@/lib/cn.ts";
import { SignInButton } from "@/features/sign-in/index.ts";

/*
 * The model picker's rows: a model (its name, a quiet detail, Default, the check on the current
 * one, ⌘1…⌘9 and a star), a group's Legacy models row that opens its older models in place,
 * a group's header with its refresh spinner, and a source's discovery error with what to do.
 */

/** What a row says beside its name: the local runtime serving it, then its snapshot detail. */
export function rowDetail(model: PickerModel): string | undefined {
  const local = model.source?.kind === "local" ? model.source.label : undefined;
  return [local, model.detail].filter(Boolean).join(" · ") || undefined;
}

/** Where a row comes from, where providers mix (a search, Favorites): "OpenCode · OpenRouter". */
function origin(model: PickerModel): string {
  const source = model.source;
  const from = source && source.kind !== "account" && source.kind !== "local" ? source.label : "";
  return [providerNames[model.provider], from].filter(Boolean).join(" · ");
}

export function ModelRow(props: {
  model: PickerModel;
  id: string;
  /** Rows of several providers: each says where it comes from. */
  mixed: boolean;
  current: boolean;
  highlighted: boolean;
  starred: boolean;
  /** Its ⌘ number, for the first nine rows. */
  number: number | undefined;
  /** Inside an open Legacy models section. */
  nested: boolean;
  onHighlight(): void;
  onPick(): void;
  onStar(): void;
}) {
  const { model } = props;
  const accounts = useAccountViews();
  const account = accounts.data?.find((entry) => entry.id === model.instance);
  const detail = rowDetail(model);
  const marker = model.isDefault ? (model.userDefault ? "Your choice" : "Recommended") : undefined;
  const subtitle = [
    props.mixed ? [origin(model), account?.label].filter(Boolean).join(" · ") : undefined,
    props.mixed && model.legacy ? "Legacy" : undefined,
    props.mixed ? model.unavailable : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const name = [
    model.label,
    freeModelMarker(model) ? "Free" : undefined,
    detail,
    marker?.toLowerCase(),
    props.mixed ? undefined : model.unavailable,
    subtitle || providerNames[model.provider],
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div role="none" className="relative">
      <div
        role="option"
        id={props.id}
        aria-selected={props.current}
        aria-disabled={model.unavailable ? true : undefined}
        data-disabled={model.unavailable ? "" : undefined}
        aria-label={name}
        data-highlighted={props.highlighted ? "" : undefined}
        onMouseMove={props.onHighlight}
        onClick={props.onPick}
        className={cn(
          menuItem,
          "gap-2 pr-9",
          subtitle ? "h-auto min-h-11 py-1.5" : "h-8",
          props.nested && "pl-6",
          !model.unavailable && "cursor-pointer",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn("truncate", props.current && "font-medium")}
              onPointerEnter={titleWhenClipped(model.label)}
            >
              {model.label}
            </span>
            {detail && (
              <span
                title={detail}
                className="min-w-0 shrink-[2] truncate text-xs text-subtle-foreground"
              >
                {detail}
              </span>
            )}
            {!props.mixed && model.unavailable && (
              <span className="shrink-0 text-xs text-status-failed">{model.unavailable}</span>
            )}
            {model.isNew && (
              <span className="shrink-0 rounded-xs bg-ring/10 px-1 text-2xs leading-4 font-semibold tracking-[0.02em] text-link">
                NEW
              </span>
            )}
            {freeModelMarker(model) && (
              <span className="shrink-0 text-xs text-subtle-foreground">Free</span>
            )}
          </span>
          {subtitle && (
            <span className="flex min-w-0 items-center gap-1 text-xs text-subtle-foreground">
              {props.mixed && (
                <ProviderAccountIcon
                  provider={model.provider}
                  instance={model.instance}
                  size={14}
                />
              )}
              <span className="truncate">{subtitle}</span>
            </span>
          )}
        </span>
        {marker && <span className="shrink-0 text-xs text-subtle-foreground">{marker}</span>}
        {props.current && <CheckIcon aria-hidden size={14} weight="bold" className="shrink-0" />}
        {props.number !== undefined && (
          <Kbd keys={`mod+${props.number}`} className="tabular-nums" />
        )}
      </div>
      <Tip label={`${props.starred ? "Remove from" : "Add to"} favorites`}>
        <button
          type="button"
          aria-label={`${props.starred ? "Remove" : "Add"} ${model.label} ${props.starred ? "from" : "to"} favorites`}
          aria-pressed={props.starred}
          tabIndex={props.highlighted ? 0 : -1}
          onClick={props.onStar}
          className={cn(
            "absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-full text-subtle-foreground outline-none transition-[color,opacity] duration-(--dur-1) hover:text-foreground focus-visible:opacity-100 focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-pressed:text-foreground",
            !props.starred && !props.highlighted && "opacity-0",
          )}
        >
          <StarIcon aria-hidden size={14} weight={props.starred ? "fill" : "regular"} />
        </button>
      </Tip>
    </div>
  );
}

/**
 * A group's "Legacy models" row: Enter, a click or → opens its older models beneath it, ← or
 * another Enter closes them. It never picks anything itself.
 */
export function LegacyToggle(props: {
  id: string;
  count: number;
  expanded: boolean;
  highlighted: boolean;
  /** The open section's id. */
  controls: string | undefined;
  onHighlight(): void;
  onToggle(): void;
}) {
  return (
    <div
      role="option"
      id={props.id}
      aria-selected={false}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      aria-label={`Legacy models, ${props.count}`}
      data-highlighted={props.highlighted ? "" : undefined}
      onMouseMove={props.onHighlight}
      onClick={props.onToggle}
      className={cn(menuItem, "h-8 cursor-pointer gap-1.5 text-muted-foreground")}
    >
      <CaretRightIcon
        aria-hidden
        size={12}
        weight="bold"
        className={cn("transition-transform duration-(--dur-1)", props.expanded && "rotate-90")}
      />
      <span className="flex-1">Legacy models</span>
      <span className="text-xs text-subtle-foreground tabular-nums">{props.count}</span>
    </div>
  );
}

/** A group's header: its source ("OpenCode Go", "Work") and a spinner while it refreshes. */
export function GroupHeader(props: { group: PickerGroup }) {
  const { label, refreshing } = props.group;
  if (!label) return null;
  return (
    <div role="presentation" className={cn(menuLabel, "flex items-center gap-1.5")}>
      <span className="truncate">{label}</span>
      {refreshing && <Spinner label={`Refreshing ${label}`} />}
    </div>
  );
}

/** Discovery problems that signing in fixes: not set up or signed out. */
const fixedBySignIn = new Set<ModelProblem["code"]>(["not_configured", "auth_expired"]);

/**
 * Why a group's list may be out of date, in the daemon's words, with what to do: "OpenRouter
 * could not be reached. Check your network and refresh models." Its last models still list.
 * Where signing in fixes it, Sign in starts that provider's (or upstream's) own sign-in.
 */
export function GroupProblem(props: { problem: ModelProblem; id: string; provider: ProviderKind }) {
  const { problem } = props;
  const refresh = useRefreshModels();
  return (
    <p
      id={props.id}
      role="presentation"
      className="flex gap-1.5 px-2.5 py-1 text-xs leading-4 text-muted-foreground"
    >
      {problem.severity !== "info" && (
        <WarningCircleIcon aria-hidden size={14} className="mt-px shrink-0 text-status-failed" />
      )}
      <span className="flex-1">
        <span className="text-foreground">{problem.message}</span> {problem.hint}
      </span>
      {problem.code === "no_models" ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={refresh.pending || Boolean(refresh.reason)}
          onClick={() => refresh.refresh(props.provider)}
        >
          Refresh
        </Button>
      ) : (
        (problem.actionId === "provider.sign_in" || fixedBySignIn.has(problem.code)) && (
          <SignInButton
            className="-my-0.5 shrink-0"
            target={{
              provider: props.provider,
              ...(problem.source ? { choice: problem.source } : {}),
            }}
          >
            Sign in
          </SignInButton>
        )
      )}
    </p>
  );
}

/** What an empty list says: nothing matched, nothing starred yet, or nothing listed. */
export function PickerEmpty(props: { query: string; favorites: boolean }) {
  const [title, hint] = props.query.trim()
    ? [`No models match “${props.query}”`, "Search looks across every provider"]
    : props.favorites
      ? ["No favorites yet", "Star a model to keep it here"]
      : ["No models", "This provider lists no models yet"];
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center"
    >
      {props.favorites && !props.query.trim() ? (
        <StarIcon aria-hidden size={20} className="mb-1 text-subtle-foreground" />
      ) : (
        <MagnifyingGlassIcon aria-hidden size={20} className="mb-1 text-subtle-foreground" />
      )}
      <p className="text-ui text-foreground">{title}</p>
      <p className="text-xs text-subtle-foreground">{hint}</p>
    </div>
  );
}
