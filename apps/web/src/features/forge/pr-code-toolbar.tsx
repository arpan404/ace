import {
  ArrowsInLineVerticalIcon,
  ArrowsOutLineVerticalIcon,
  ColumnsIcon,
  RowsIcon,
  SlidersHorizontalIcon,
  TextAlignLeftIcon,
  TreeStructureIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import type { ForgeCommit } from "@ace/protocol";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";

export type DiffMode = "unified" | "split";

/** What the person chose about how the diff draws. */
export interface CodeOptions {
  mode: DiffMode;
  wrap: boolean;
  tree: boolean;
}

/**
 * The Code tab's toolbar: the commit in scope and how many files are viewed on the left; one
 * warning for what can't be shown; layout, wrap, fold-all and the files tree on the right. In a
 * narrow panel (its `@container/code`) the right side folds into one Diff options menu.
 */
export function PrCodeToolbar(props: {
  commit: string;
  commits: readonly ForgeCommit[];
  onCommit(commit: string): void;
  files: number;
  viewed: number | undefined;
  caveats: readonly string[];
  options: CodeOptions;
  onOptions(change: Partial<CodeOptions>): void;
  allCollapsed: boolean;
  onCollapseAll(fold: boolean): void;
}) {
  const { options } = props;
  const counts = `${props.files} ${props.files === 1 ? "file" : "files"}${
    props.viewed === undefined ? "" : ` · ${props.viewed} / ${props.files} viewed`
  }`;
  return (
    <div
      role="toolbar"
      aria-label="Diff controls"
      className={cn("flex h-10 shrink-0 items-center gap-2 bg-panel px-3", toolbarEdge)}
    >
      <Select
        label="Commit range"
        className="h-7 w-40 min-w-0 shrink"
        value={props.commit}
        onValueChange={props.onCommit}
        options={[
          { value: "", label: "All commits" },
          ...props.commits.map((commit) => ({
            value: commit.sha,
            label: `${commit.sha.slice(0, 7)} ${commit.message.split("\n")[0] ?? ""}`,
          })),
        ]}
      />
      <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">{counts}</span>
      {props.caveats.length > 0 && (
        <Tip
          label={
            <ul className="space-y-0.5">
              {props.caveats.map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          }
        >
          <button
            type="button"
            aria-label={props.caveats.join(" ")}
            className="grid size-6 shrink-0 place-items-center rounded-sm text-status-needs-you outline-none focus-ring"
          >
            <WarningIcon aria-hidden size={14} />
          </button>
        </Tip>
      )}
      <span className="flex-1" />
      <div className="hidden items-center gap-0.5 @[32rem]/code:flex">
        <div role="group" aria-label="Diff layout" className="flex">
          <IconButton
            size="sm"
            icon={RowsIcon}
            label="Stacked diff"
            pressed={options.mode === "unified"}
            onClick={() => props.onOptions({ mode: "unified" })}
          />
          <IconButton
            size="sm"
            icon={ColumnsIcon}
            label="Split diff"
            pressed={options.mode === "split"}
            onClick={() => props.onOptions({ mode: "split" })}
          />
        </div>
        <IconButton
          size="sm"
          icon={TextAlignLeftIcon}
          label="Wrap lines"
          pressed={options.wrap}
          onClick={() => props.onOptions({ wrap: !options.wrap })}
        />
        <IconButton
          size="sm"
          icon={props.allCollapsed ? ArrowsOutLineVerticalIcon : ArrowsInLineVerticalIcon}
          label={props.allCollapsed ? "Expand all files" : "Collapse all files"}
          onClick={() => props.onCollapseAll(!props.allCollapsed)}
        />
        <IconButton
          size="sm"
          icon={TreeStructureIcon}
          label={options.tree ? "Hide file tree" : "Show file tree"}
          pressed={options.tree}
          onClick={() => props.onOptions({ tree: !options.tree })}
        />
      </div>
      <Menu>
        <MenuTrigger
          render={
            <IconButton
              size="sm"
              icon={SlidersHorizontalIcon}
              label="Diff options"
              className="@[32rem]/code:hidden"
            />
          }
        />
        <MenuContent align="end">
          <MenuRadioGroup
            value={options.mode}
            onValueChange={(mode: DiffMode) => props.onOptions({ mode })}
          >
            <MenuLabel>Layout</MenuLabel>
            <MenuRadioItem closeOnClick value="unified">
              Stacked
            </MenuRadioItem>
            <MenuRadioItem closeOnClick value="split">
              Split
            </MenuRadioItem>
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuCheckboxItem
            checked={options.wrap}
            onCheckedChange={(wrap) => props.onOptions({ wrap })}
          >
            Wrap lines
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={options.tree}
            onCheckedChange={(tree) => props.onOptions({ tree })}
          >
            File tree
          </MenuCheckboxItem>
          <MenuItem onClick={() => props.onCollapseAll(!props.allCollapsed)}>
            {props.allCollapsed ? "Expand all files" : "Collapse all files"}
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
