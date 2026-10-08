import {
  ArrowElbowDownLeftIcon,
  ArrowsInLineVerticalIcon,
  ArrowsOutLineVerticalIcon,
  CaretDownIcon,
  ColumnsIcon,
  RowsIcon,
  TreeViewIcon,
} from "@phosphor-icons/react";
import type { Turn } from "@ace/ui-core";
import { scopeLabel, type Scope } from "@/lib/diffs/use-scoped-diff.ts";
export { scopeLabel, type Scope };
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { DiffPrefs } from "../services.ts";
import { DiffStat } from "./diff-stat.tsx";

const control = "size-7";

/**
 * Checkout scopes the daemon can't diff yet, listed so the gap is visible rather than guessed:
 * `thread.details` carries uncommitted counts, never the hunks, and nothing reports the index or
 * a base branch's diff.
 */
const unavailable = [
  { label: "Staged", reason: "Staged changes aren't available yet" },
  {
    label: "Branch",
    reason: "Comparing with the base branch isn't available yet",
  },
] as const;

/** The scope menu: last turn, all turns, one turn, and the checkout scopes that can't open yet. */
export function ScopeMenu(props: {
  scope: Scope;
  turns: readonly Turn[];
  onScope(scope: Scope): void;
}) {
  const last = props.turns.at(-1);
  return (
    <Menu>
      <Tip label="What to show">
        <MenuTrigger
          aria-label={`Scope: ${scopeLabel(props.scope, props.turns)}`}
          className="flex h-7 min-w-0 items-center gap-1 rounded-sm px-2 text-sm font-medium text-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent focus-ring aria-expanded:bg-accent"
        >
          <span className="truncate">{scopeLabel(props.scope, props.turns)}</span>
          <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
        </MenuTrigger>
      </Tip>
      <MenuContent className="max-h-[min(420px,var(--available-height))] overflow-y-auto">
        <MenuRadioGroup value={props.scope} onValueChange={(value: Scope) => props.onScope(value)}>
          <MenuRadioItem closeOnClick value="working-tree">
            Uncommitted
          </MenuRadioItem>
          <MenuRadioItem closeOnClick value="last">
            Last turn{last ? ` · Turn ${last.number}` : ""}
          </MenuRadioItem>
          <MenuRadioItem closeOnClick value="all">
            All turns
          </MenuRadioItem>
          {props.turns.length > 1 && (
            <>
              <MenuSeparator />
              <MenuLabel>Turns</MenuLabel>
              {props.turns.map((turn) => (
                <MenuRadioItem closeOnClick key={turn.id} value={turn.id}>
                  Turn {turn.number}
                </MenuRadioItem>
              ))}
            </>
          )}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuLabel>Checkout</MenuLabel>
          {unavailable.map((entry) => (
            <MenuItem key={entry.label} disabled reason={entry.reason}>
              {entry.label}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}

const modeLabels: Record<DiffPrefs["mode"], string> = {
  auto: "Auto",
  unified: "Unified",
  split: "Split",
};

/** Auto, Unified or Split; Auto names the layout it picked for the panel's width. */
function LayoutMenu(props: {
  mode: DiffPrefs["mode"];
  shown: "unified" | "split";
  /** Split is chosen but the panel is too narrow for it: unified shows until it widens. */
  splitTooNarrow: boolean;
  onMode(mode: DiffPrefs["mode"]): void;
}) {
  const note =
    props.mode === "auto"
      ? ` (${modeLabels[props.shown]})`
      : props.splitTooNarrow
        ? " (needs a wider panel)"
        : "";
  const label = `Diff layout: ${modeLabels[props.mode]}${note}`;
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            icon={props.shown === "split" ? ColumnsIcon : RowsIcon}
            label={label}
            className={control}
          />
        }
      />
      <MenuContent align="end">
        <MenuRadioGroup
          value={props.mode}
          onValueChange={(mode: DiffPrefs["mode"]) => props.onMode(mode)}
        >
          <MenuLabel>Diff layout</MenuLabel>
          <MenuRadioItem closeOnClick value="auto">
            Auto · {modeLabels[props.shown]} at this width
          </MenuRadioItem>
          <MenuRadioItem closeOnClick value="unified">
            Unified
          </MenuRadioItem>
          <MenuRadioItem closeOnClick value="split">
            Split{props.splitTooNarrow && " · needs a wider panel"}
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/**
 * Changes' toolbar: scope and its totals on the left; wrap, fold every file, layout and the
 * files tree on the right. 40px tall with 28px controls on one centre line.
 */
export function ChangesToolbar(props: {
  scope: Scope;
  turns: readonly Turn[];
  onScope(scope: Scope): void;
  stat: { additions: number; deletions: number };
  prefs: DiffPrefs;
  shown: "unified" | "split";
  splitTooNarrow: boolean;
  onPrefs(change: (prefs: DiffPrefs) => DiffPrefs): void;
  allCollapsed: boolean;
  onCollapseAll(folded: boolean): void;
  /** The tree only helps with more than one file. */
  canShowTree: boolean;
}) {
  const { prefs } = props;
  return (
    <div
      role="toolbar"
      aria-label="Changes"
      className="flex h-10 shrink-0 items-center gap-1 border-b bg-panel pr-2 pl-1.5"
    >
      <ScopeMenu scope={props.scope} turns={props.turns} onScope={props.onScope} />
      <DiffStat {...props.stat} className="ml-1 shrink-0 text-sm" />
      <span className="flex-1" />
      <IconButton
        icon={ArrowElbowDownLeftIcon}
        label="Wrap long lines"
        pressed={prefs.wrap}
        className={control}
        onClick={() => props.onPrefs((value) => ({ ...value, wrap: !value.wrap }))}
      />
      <IconButton
        icon={props.allCollapsed ? ArrowsOutLineVerticalIcon : ArrowsInLineVerticalIcon}
        label={props.allCollapsed ? "Expand all files" : "Collapse all files"}
        className={control}
        onClick={() => props.onCollapseAll(!props.allCollapsed)}
      />
      <LayoutMenu
        mode={prefs.mode}
        shown={props.shown}
        splitTooNarrow={props.splitTooNarrow}
        onMode={(mode) => props.onPrefs((value) => ({ ...value, mode }))}
      />
      {props.canShowTree && (
        <IconButton
          icon={TreeViewIcon}
          label={prefs.tree ? "Hide files" : "Show files"}
          pressed={prefs.tree}
          className={control}
          onClick={() => props.onPrefs((value) => ({ ...value, tree: !value.tree }))}
        />
      )}
    </div>
  );
}
