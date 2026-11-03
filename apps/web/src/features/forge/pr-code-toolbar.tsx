import { SlidersHorizontalIcon, WarningIcon } from "@phosphor-icons/react";
import type { ForgeCommit } from "@ace/protocol";
import {
  codeScopeKey,
  formatAgo,
  parseCodeScope,
  type CodeScope,
  type SinceLastReview,
} from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
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
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { useNow } from "@/lib/time.ts";
import { cn } from "@/lib/cn.ts";
import type { CodeOptions, DiffMode } from "./pr-code-options.ts";

export type { CodeOptions, DiffMode } from "./pr-code-options.ts";

const short = (sha: string) => sha.slice(0, 7);
const headline = (commit: ForgeCommit) => commit.message.split("\n")[0] ?? "";
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Which commits show: All commits, Since your review, one commit, and with one commit picked,
 * how far the span runs ("Through …").
 */
function CommitChoice(props: {
  scope: CodeScope;
  commits: readonly ForgeCommit[];
  since: SinceLastReview | undefined;
  onScope(scope: CodeScope): void;
}) {
  const { scope, commits } = props;
  const value = codeScopeKey(scope);
  const span =
    scope.kind === "commits" && scope.from !== scope.to
      ? commits.findIndex((c) => c.sha === scope.to) -
        commits.findIndex((c) => c.sha === scope.from) +
        1
      : 0;
  const options = [
    { value: "all", label: "All commits" },
    ...(props.since || scope.kind === "since-review"
      ? [
          {
            value: "since-review",
            label: props.since
              ? `Since your review · ${plural(props.since.count, "commit")}`
              : "Since your review",
          },
        ]
      : []),
    ...(span > 0 && scope.kind === "commits"
      ? [{ value, label: `${plural(span, "commit")} · ${short(scope.from)}…${short(scope.to)}` }]
      : []),
    ...commits.map((commit) => ({
      value: commit.sha,
      label: `${short(commit.sha)} ${headline(commit)}`,
    })),
  ];
  const from = scope.kind === "commits" ? commits.findIndex((c) => c.sha === scope.from) : -1;
  // A span needs the commit before its first: from the first commit, only the commit itself.
  const later = from > 0 ? commits.slice(from + 1) : [];
  return (
    <>
      <Select
        label="Commit range"
        className="h-7 w-48 min-w-0 shrink"
        value={value}
        onValueChange={(key) => {
          const next = parseCodeScope(key);
          // Picking the span's own entry keeps it; any commit starts a new choice.
          props.onScope(next);
        }}
        options={options}
      />
      {scope.kind === "commits" && later.length > 0 && (
        <Select
          label="Through commit"
          className="h-7 w-40 min-w-0 shrink"
          value={scope.to}
          onValueChange={(to) => props.onScope({ kind: "commits", from: scope.from, to })}
          options={[
            { value: scope.from, label: "This commit only" },
            ...later.map((commit) => ({
              value: commit.sha,
              label: `Through ${short(commit.sha)} ${headline(commit)}`,
            })),
          ]}
        />
      )}
    </>
  );
}

/** "Pushed 4m ago · your place kept": the head moved while the tab was open. */
function PushedNote(props: { at: number }) {
  const now = useNow();
  return (
    <span className="hidden shrink-0 text-xs whitespace-nowrap text-subtle-foreground @[40rem]/code:inline">
      {`Pushed ${formatAgo(props.at, now)} · your place kept`}
    </span>
  );
}

/**
 * The Code tab's toolbar: which commits show and how many files are viewed on the left, with
 * one warning for what can't be shown; then layout, whitespace, and Next comment / Next file
 * with their keys. In a narrow panel (its `@container/code`) the options fold into one menu.
 */
export function PrCodeToolbar(props: {
  scope: CodeScope;
  commits: readonly ForgeCommit[];
  since: SinceLastReview | undefined;
  onScope(scope: CodeScope): void;
  files: number;
  viewed: number | undefined;
  caveats: readonly string[];
  options: CodeOptions;
  onOptions(change: Partial<CodeOptions>): void;
  allCollapsed: boolean;
  onCollapseAll(fold: boolean): void;
  /** When the head moved while the tab was open. */
  pushedAt?: number | undefined;
  onNextComment?: (() => void) | undefined;
  onNextFile(): void;
}) {
  const { options } = props;
  const counts = `${plural(props.files, "file")}${
    props.viewed === undefined ? "" : ` · ${props.viewed} / ${props.files} viewed`
  }`;
  return (
    <div
      role="toolbar"
      aria-label="Diff controls"
      className={cn("flex h-10 shrink-0 items-center gap-2 bg-panel px-3", toolbarEdge)}
    >
      <CommitChoice
        scope={props.scope}
        commits={props.commits}
        since={props.since}
        onScope={props.onScope}
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
      {props.pushedAt !== undefined && <PushedNote at={props.pushedAt} />}
      <div className="hidden items-center gap-1 @[44rem]/code:flex">
        <SegmentedControl
          label="Diff layout"
          size="sm"
          value={options.mode}
          options={[
            { value: "unified", label: "Unified" },
            { value: "split", label: "Split" },
          ]}
          onValueChange={(mode: DiffMode) => props.onOptions({ mode })}
        />
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={options.hideWhitespace}
          className={cn(options.hideWhitespace && "text-foreground")}
          onClick={() => props.onOptions({ hideWhitespace: !options.hideWhitespace })}
        >
          Hide whitespace
        </Button>
      </div>
      <div className="hidden items-center gap-1 @[32rem]/code:flex">
        {props.onNextComment && (
          <Button size="xs" variant="ghost" onClick={props.onNextComment}>
            Next comment <Kbd variant="bare">c</Kbd>
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={props.onNextFile}>
          Next file <Kbd variant="bare">n</Kbd>
        </Button>
      </div>
      <Menu>
        <MenuTrigger
          render={<IconButton size="sm" icon={SlidersHorizontalIcon} label="Diff options" />}
        />
        <MenuContent align="end">
          <MenuRadioGroup
            value={options.mode}
            onValueChange={(mode: DiffMode) => props.onOptions({ mode })}
          >
            <MenuLabel>Layout</MenuLabel>
            <MenuRadioItem closeOnClick value="unified">
              Unified
            </MenuRadioItem>
            <MenuRadioItem closeOnClick value="split">
              Split
            </MenuRadioItem>
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuCheckboxItem
            checked={options.hideWhitespace}
            onCheckedChange={(hideWhitespace) => props.onOptions({ hideWhitespace })}
          >
            Hide whitespace
          </MenuCheckboxItem>
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
