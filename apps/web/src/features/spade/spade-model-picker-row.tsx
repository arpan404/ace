import {
  spadeModelFacts,
  spadeWorksWell,
  type SpadeEndpoint,
  type SpadeModelInfo,
  type SpadeModelOption,
} from "@ace/ui-core/spade-chat";
import { CheckIcon, MagnifyingGlassIcon, StarIcon } from "@ace/icons";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { SpadeModelCapabilities } from "./spade-model-capabilities.tsx";
import { SpadeModelMark, SpadeProviderMark } from "./spade-marks.tsx";

/** One model in Spade's picker: its mark, name, facts, capabilities, ⌘ number and star. */
export function SpadePickerRow(props: {
  id: string;
  option: SpadeModelOption;
  endpoint: SpadeEndpoint | undefined;
  modelInfo: SpadeModelInfo | undefined;
  modelId: string;
  mixed: boolean;
  isEmpty: boolean;
  chosen: boolean;
  highlighted: boolean;
  starred: boolean;
  number: number | undefined;
  onHighlight(): void;
  onPick(): void;
  onStar(): void;
}) {
  const { option, endpoint, modelInfo, isEmpty } = props;
  const revealed = props.highlighted || props.chosen;
  const showCapabilities = !isEmpty && !option.cant && (modelInfo?.capabilities.length ?? 0) > 0;
  const baseFacts =
    showCapabilities && modelInfo
      ? endpoint?.local
        ? [
            modelInfo.knownGood
              ? spadeWorksWell
              : spadeModelFacts({ context: modelInfo.context, capabilities: [] }),
            "Runs on this computer",
          ]
            .filter(Boolean)
            .join(" · ")
        : spadeModelFacts({ context: modelInfo.context, capabilities: [] })
      : option.facts;
  const subtitle = isEmpty
    ? option.facts
    : props.mixed
      ? [option.source, baseFacts].filter(Boolean).join(" · ")
      : baseFacts;
  const canStar = !isEmpty && !option.typed && !option.adds;

  if (isEmpty) {
    return (
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- keys pick through the combobox's aria-activedescendant
      <div
        id={props.id}
        role="option"
        aria-selected={props.chosen}
        tabIndex={-1}
        data-highlighted={props.highlighted ? "" : undefined}
        onMouseMove={props.highlighted ? undefined : props.onHighlight}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onPick}
        className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-ui text-foreground select-none data-highlighted:bg-accent focus-ring-inset"
      >
        <span className="min-w-0 truncate font-medium">{option.name}</span>
        {subtitle && (
          <span className="min-w-0 flex-1 truncate text-right text-xs text-subtle-foreground">
            {subtitle}
          </span>
        )}
        {props.chosen && <CheckIcon aria-hidden size={12} weight="bold" className="shrink-0" />}
      </div>
    );
  }

  return (
    <div role="none" className="group/row relative">
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- keys pick through the combobox's aria-activedescendant */}
      <div
        id={props.id}
        role="option"
        {...part(
          "menu-item",
          option.cant ? "disabled" : props.chosen ? "checked" : undefined,
          "option",
        )}
        aria-selected={props.chosen}
        aria-disabled={option.cant ? true : undefined}
        data-disabled={option.cant ? "" : undefined}
        data-highlighted={props.highlighted ? "" : undefined}
        tabIndex={-1}
        title={option.cant}
        onMouseMove={props.highlighted ? undefined : props.onHighlight}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onPick}
        className={cn(
          "flex h-11 w-full items-center gap-2 rounded-md px-2.5 text-ui whitespace-nowrap text-foreground select-none data-highlighted:bg-accent data-disabled:opacity-50 focus-ring-inset",
          canStar ? "pr-8" : "pr-2.5",
          !option.cant && "cursor-pointer",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            {endpoint && !option.typed && (
              <SpadeModelMark
                model={{ id: props.modelId, name: option.name }}
                account={endpoint}
                size={14}
                className="shrink-0"
                decorative
              />
            )}
            <span className="truncate font-medium">{option.name}</span>
          </span>
          {(subtitle || showCapabilities) && (
            <span
              className={cn(
                "flex min-w-0 items-center gap-1 text-xs leading-4 text-subtle-foreground",
                option.cant && "text-status-failed",
              )}
            >
              {props.mixed && endpoint && (
                <SpadeProviderMark
                  account={endpoint}
                  name={option.source ?? endpoint.name}
                  size={12}
                  className="size-3 shrink-0"
                  decorative
                />
              )}
              {subtitle && <span className="truncate">{subtitle}</span>}
              {subtitle && showCapabilities && <span aria-hidden>·</span>}
              {showCapabilities && modelInfo && (
                <SpadeModelCapabilities capabilities={modelInfo.capabilities} size={12} />
              )}
            </span>
          )}
        </span>
        {props.chosen && <CheckIcon aria-hidden size={12} weight="bold" className="shrink-0" />}
        {props.number !== undefined && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-(--motion-fast) group-hover/row:opacity-100",
              canStar ? (props.chosen ? "right-12" : "right-8") : "right-2.5",
              revealed && "opacity-100",
            )}
          >
            <Kbd
              keys={`mod+${props.number}`}
              variant="bare"
              className="bg-transparent tabular-nums"
            />
          </span>
        )}
      </div>
      {canStar && (
        <Tip label={`${props.starred ? "Remove from" : "Add to"} favorites`}>
          <button
            type="button"
            aria-label={`${props.starred ? "Remove" : "Add"} ${option.name} ${props.starred ? "from" : "to"} favorites`}
            aria-pressed={props.starred}
            tabIndex={props.highlighted ? 0 : -1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={props.onStar}
            className={cn(
              "absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-subtle-foreground opacity-0 transition-[color,opacity] duration-(--motion-fast) group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-ring-inset aria-pressed:text-link pointer-coarse:opacity-100",
              (revealed || props.starred) && "opacity-100",
            )}
          >
            <StarIcon aria-hidden size={14} weight={props.starred ? "fill" : "regular"} />
          </button>
        </Tip>
      )}
    </div>
  );
}

/** What an empty Spade picker says: no providers, no matches, or no favorites yet. */
export function SpadePickerEmpty(props: { icon: "star" | "search"; title: string; hint: string }) {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center"
    >
      {props.icon === "star" ? (
        <StarIcon aria-hidden size={20} className="mb-1 text-subtle-foreground" />
      ) : (
        <MagnifyingGlassIcon aria-hidden size={20} className="mb-1 text-subtle-foreground" />
      )}
      <p className="text-ui text-foreground">{props.title}</p>
      <p className="text-xs text-subtle-foreground">{props.hint}</p>
    </div>
  );
}
