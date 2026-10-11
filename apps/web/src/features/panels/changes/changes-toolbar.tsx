import { CaretDownIcon, DotsThreeIcon } from "@phosphor-icons/react";
import type { Turn } from "@ace/ui-core";
import { scopeLabel, type Scope } from "@/lib/diffs/use-scoped-diff.ts";
export { scopeLabel, type Scope };
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuCheckboxItem,
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
            This thread
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
      </MenuContent>
    </Menu>
  );
}

const modeLabels: Record<DiffPrefs["mode"], string> = {
  auto: "Auto",
  unified: "Unified",
  split: "Split",
};

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
  onRefreshReview(): void;
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
      <Menu>
        <MenuTrigger
          render={<IconButton icon={DotsThreeIcon} label="Diff options" className={control} />}
        />
        <MenuContent align="end">
          <MenuCheckboxItem
            checked={prefs.wrap}
            onCheckedChange={(wrap) => props.onPrefs((value) => ({ ...value, wrap }))}
          >
            Wrap long lines
          </MenuCheckboxItem>
          <MenuItem onClick={() => props.onCollapseAll(!props.allCollapsed)}>
            {props.allCollapsed ? "Expand all files" : "Collapse all files"}
          </MenuItem>
          {props.canShowTree && (
            <MenuCheckboxItem
              checked={prefs.tree}
              onCheckedChange={(tree) => props.onPrefs((value) => ({ ...value, tree }))}
            >
              Show files
            </MenuCheckboxItem>
          )}
          <MenuItem onClick={props.onRefreshReview}>Refresh comments</MenuItem>
          <MenuSeparator />
          <MenuRadioGroup
            value={prefs.mode}
            onValueChange={(mode: DiffPrefs["mode"]) =>
              props.onPrefs((value) => ({ ...value, mode }))
            }
          >
            <MenuLabel>Diff layout</MenuLabel>
            <MenuRadioItem closeOnClick value="auto">
              Auto · {modeLabels[props.shown]}
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
    </div>
  );
}
