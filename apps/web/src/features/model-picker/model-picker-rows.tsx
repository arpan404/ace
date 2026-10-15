import { Button } from "@/components/ui/button.tsx";
import { useRefreshModels } from "./use-refresh-models.ts";
import type { ProviderKind } from "@ace/protocol";
import type { ModelProblem, PickerModel } from "@ace/ui-core";
import { isPlainCliLogin, providerNames, freeModelMarker } from "@ace/ui-core";
import {
  CaretRightIcon,
  CheckIcon,
  MagnifyingGlassIcon,
  StarIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Kbd } from "@/components/ui/kbd.tsx";
import { menuItem } from "@/components/ui/menu-styles.ts";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useAccountViews } from "@/lib/account-views.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
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
  const from = source && source.kind !== "account" ? source.label : "";
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
  // The CLI's own login, never renamed, stands for the provider: no account in the row or its
  // tooltip ("Codex", not "Codex · Your CLI login").
  const plain = account !== undefined && isPlainCliLogin(account);
  const accountLabel = plain
    ? undefined
    : (account?.label ?? (model.source?.kind === "account" ? model.source.label : undefined));
  const subtitle = [
    [origin(model), accountLabel].filter(Boolean).join(" · "),
    props.mixed && model.legacy ? "Legacy" : undefined,
    model.unavailable,
  ]
    .filter(Boolean)
    .join(" · ");
  const name = [
    model.label,
    model.isNew ? "New" : undefined,
    freeModelMarker(model) ? "Free" : undefined,
    detail,
    marker?.toLowerCase(),
    subtitle || providerNames[model.provider],
  ]
    .filter(Boolean)
    .join(", ");
  // The second line: where the row comes from, always ("Codex · Personal", "OpenCode · OpenCode
  // Zen"), with the account unless it is the CLI's own login, which stands for the provider.
  const sourceLabel =
    model.source && model.source.kind !== "account" ? model.source.label : undefined;
  const from = [
    providerNames[model.provider],
    // An account named after its source ("OpenRouter API") already says where it comes from.
    sourceLabel && accountLabel?.startsWith(sourceLabel) ? undefined : sourceLabel,
    accountLabel,
    props.mixed && model.legacy ? "Legacy" : undefined,
    model.unavailable,
  ]
    .filter(Boolean)
    .join(" · ");
  // ⌘N and the star show on the highlighted (hovered or keyboard) row and the chosen one.
  const revealed = props.highlighted || props.current;
  // The hover card's line: the name, what marks it, and where it comes from.
  const tip = [
    model.label,
    model.isNew ? "New" : undefined,
    freeModelMarker(model) ? "Free" : undefined,
    detail,
    marker,
    from || providerNames[model.provider],
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div role="none" className="group/row relative">
      <Tip label={tip} side="right">
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
            "flex h-11 w-full items-center gap-2 rounded-md px-2.5 pr-8 text-ui whitespace-nowrap text-foreground select-none data-highlighted:bg-accent data-disabled:opacity-50 focus-ring-inset",
            !model.unavailable && "cursor-pointer",
          )}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium">{model.label}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1 text-xs leading-4 text-subtle-foreground">
              {/* Only where providers mix (a search, Favorites); a provider's own tab is
                  already named by the rail. */}
              {props.mixed && (
                <ProviderIcon
                  provider={model.provider}
                  acpAgentId={account?.acpAgentId}
                  size={12}
                  className="size-3 shrink-0"
                  decorative
                />
              )}
              <span className="truncate">{from}</span>
            </span>
          </span>

          {props.number !== undefined && (
            <Kbd
              keys={`mod+${props.number}`}
              variant="bare"
              className={cn(
                "bg-transparent tabular-nums opacity-0 group-hover/row:opacity-100",
                revealed && "opacity-100",
              )}
            />
          )}
          {props.current && <CheckIcon aria-hidden size={12} weight="bold" className="shrink-0" />}
        </div>
      </Tip>
      <Tip label={`${props.starred ? "Remove from" : "Add to"} favorites`}>
        <button
          type="button"
          aria-label={`${props.starred ? "Remove" : "Add"} ${model.label} ${props.starred ? "from" : "to"} favorites`}
          aria-pressed={props.starred}
          tabIndex={props.highlighted ? 0 : -1}
          onClick={props.onStar}
          className={cn(
            "absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-subtle-foreground opacity-0 transition-[color,opacity] duration-(--motion-fast) group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-ring-inset aria-pressed:text-link pointer-coarse:opacity-100",
            revealed && "opacity-100",
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
      className={cn(
        menuItem,
        "h-11 cursor-pointer gap-2 px-2.5 text-muted-foreground focus-ring-inset",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui font-medium text-foreground">Legacy models</span>
        <span className="text-xs leading-4 text-subtle-foreground tabular-nums">
          {props.count} {props.count === 1 ? "model" : "models"}
        </span>
      </span>
      <CaretRightIcon
        aria-hidden
        size={12}
        weight="bold"
        className={cn(
          "shrink-0 transition-transform duration-(--motion-fast)",
          props.expanded && "rotate-90",
        )}
      />
    </div>
  );
}

/** Discovery problems that signing in fixes: not set up or signed out. */
const fixedBySignIn = new Set<ModelProblem["code"]>(["not_configured", "auth_expired"]);

/** Whether signing in is the fix, so the account's own row can offer it instead. */
export function isSignInProblem(problem: ModelProblem): boolean {
  return problem.actionId === "provider.sign_in" || fixedBySignIn.has(problem.code);
}

/**
 * Why a group's list may be out of date, in the daemon's words, with what to do: "OpenRouter
 * could not be reached. Check your network and refresh models." Its last models still list.
 * Where signing in fixes it, Sign in starts that provider's (or upstream's) own sign-in.
 */
export function GroupProblem(props: {
  problem: ModelProblem;
  id: string;
  provider: ProviderKind;
  /** Where it sits decides its inset: the picker's rows, or a settings row's own. */
  className?: string;
}) {
  const { problem } = props;
  const refresh = useRefreshModels();
  return (
    <p
      id={props.id}
      role="presentation"
      className={cn(
        "flex gap-1.5 px-2.5 py-1 text-xs leading-4 text-muted-foreground",
        props.className,
      )}
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
        isSignInProblem(problem) && (
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
