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

/** Which edits Changes shows: the latest turn's, every turn's, or one turn's (by run id). */
export type Scope = "last" | "all" | (string & {});

const control = "size-7";

/**
 * Checkout scopes the daemon can't diff yet, listed so the gap is visible rather than guessed:
 * `thread.details` carries uncommitted counts, never the hunks, and nothing reports the index or
 * a base branch's diff.
 */
const unavailable = [
  {
    label: "Uncommitted",
    reason: "The daemon reports how much is uncommitted, not the diff itself",
  },
  { label: "Staged", reason: "The daemon doesn't report the git index yet" },
  {
    label: "Branch",
    reason: "Comparing with the base branch needs a branch diff the daemon can't send yet",
  },
] as const;

export function scopeLabel(scope: Scope, turns: readonly Turn[]): string {
  if (scope === "all") return "All turns";
  if (scope === "last") return "Last turn";
  const turn = turns.find((candidate) => candidate.id === scope);
  return turn ? `Turn ${turn.number}` : "Last turn";
}

/** The scope menu: last turn, all turns, one turn, and the checkout scopes that can't open yet. */
function ScopeMenu(props: { scope: Scope; turns: readonly Turn[]; onScope(scope: Scope): void }) {
  const last = props.turns.at(-1);
  return (
    <Menu>
      <Tip label="What to show">
        <MenuTrigger
          aria-label={`Scope: ${scopeLabel(props.scope, props.turns)}`}
          className="flex h-7 min-w-0 items-center gap-1 rounded-[7px] px-2 text-sm font-medium text-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-expanded:bg-accent"
        >
          <span className="truncate">{scopeLabel(props.scope, props.turns)}</span>
          <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
        </MenuTrigger>
      </Tip>
      <MenuContent className="max-h-[min(420px,var(--available-height))] overflow-y-auto">
        <MenuRadioGroup value={props.scope} onValueChange={(value: Scope) => props.onScope(value)}>
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

/** Auto, Unified or Split; Auto names the layout it picked for the dock's width. */
function LayoutMenu(props: {
  mode: DiffPrefs["mode"];
  shown: "unified" | "split";
  onMode(mode: DiffPrefs["mode"]): void;
}) {
  const label = `Diff layout: ${modeLabels[props.mode]}${props.mode === "auto" ? ` (${modeLabels[props.shown]})` : ""}`;
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
            Split
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
      <DiffStat {...props.stat} className="ml-1 shrink-0 text-[12px]" />
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
