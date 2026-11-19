import { Fragment } from "react";
import type { ForgeCommit } from "@ace/protocol";
import {
  codeScopeKey,
  formatAgo,
  parseCodeScope,
  type CodeScope,
  type SinceLastReview,
} from "@ace/ui-core";
import { Kbd } from "@/components/ui/kbd.tsx";
import { MenuCheckboxItem, MenuGroup, MenuLabel, MenuSeparator } from "@/components/ui/menu.tsx";
import { DiffViewMenu } from "@/features/panels/index.ts";
import { Select } from "@/components/ui/select.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { useNow } from "@/lib/time.ts";
import { cn } from "@/lib/cn.ts";
import type { CodeOptions, DiffMode } from "./pr-code-options.ts";
import { TextAction } from "./pr-text-action.tsx";

export type { CodeOptions, DiffMode } from "./pr-code-options.ts";

/** The Code tab's keys (`prCodeShortcut`), listed in the View menu rather than on the bar. */
const codeKeyHints: readonly (readonly [string, string])[] = [
  ["n / N", "Next / previous file"],
  ["c / C", "Next / previous comment"],
  ["u", "Next unresolved"],
  ["v / V", "Viewed / next unviewed"],
];

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
 * The Code tab's toolbar: which commits show on the left, with a quiet note for what can't be
 * shown; Next comment and Next file as words (their keys in the tooltip) and the View menu every
 * diff viewer shares (layout, folds, wrapping, whitespace, the file tree) on the right. How many files are viewed shows
 * once: in the tree's header, or here while the tree is hidden.
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
  /** The layout drawn, after Auto and the room available. */
  shown: DiffMode;
  splitTooNarrow: boolean;
  allCollapsed: boolean;
  onCollapseAll(fold: boolean): void;
  /** When the head moved while the tab was open. */
  pushedAt?: number | undefined;
  onNextComment?: (() => void) | undefined;
  onNextFile(): void;
}) {
  const { options } = props;
  const counts =
    props.viewed === undefined
      ? plural(props.files, "file")
      : `${props.viewed} of ${plural(props.files, "file")} viewed`;
  return (
    <div
      role="toolbar"
      aria-label="Diff controls"
      className={cn("flex h-10 shrink-0 items-center gap-3 bg-panel px-3", toolbarEdge)}
    >
      <CommitChoice
        scope={props.scope}
        commits={props.commits}
        since={props.since}
        onScope={props.onScope}
      />
      {/* Once: here while the tree is off or stepped aside for room, else in the tree's header. */}
      <span
        className={cn(
          "min-w-0 truncate text-xs text-muted-foreground tabular-nums",
          options.tree && "hidden @max-[40rem]/code:inline",
        )}
      >
        {counts}
      </span>
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
          <TextAction aria-label={props.caveats.join(" ")} className="shrink-0">
            {plural(props.caveats.length, "note")}
          </TextAction>
        </Tip>
      )}
      <span className="flex-1" />
      {props.pushedAt !== undefined && <PushedNote at={props.pushedAt} />}
      <div className="hidden items-center gap-3 @[32rem]/code:flex">
        {props.onNextComment && (
          <Tip label="Next comment" keys="c" resolve={false}>
            <TextAction onClick={props.onNextComment}>Next comment</TextAction>
          </Tip>
        )}
        <Tip label="Next file" keys="n" resolve={false}>
          <TextAction onClick={props.onNextFile}>Next file</TextAction>
        </Tip>
      </div>
      <DiffViewMenu
        trigger={<TextAction className="shrink-0">View</TextAction>}
        prefs={options}
        onPrefs={props.onOptions}
        shown={props.shown}
        splitTooNarrow={props.splitTooNarrow}
        canShowTree
        allCollapsed={props.allCollapsed}
        onCollapseAll={props.onCollapseAll}
        options={
          <MenuCheckboxItem
            checked={options.hideWhitespace}
            onCheckedChange={(hideWhitespace) => props.onOptions({ hideWhitespace })}
          >
            Hide whitespace changes
          </MenuCheckboxItem>
        }
        footer={
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuLabel>Keys</MenuLabel>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-2 pb-1.5 text-xs text-muted-foreground">
                {codeKeyHints.map(([keys, what]) => (
                  <Fragment key={keys}>
                    <dt>
                      <Kbd variant="bare">{keys}</Kbd>
                    </dt>
                    <dd>{what}</dd>
                  </Fragment>
                ))}
              </dl>
            </MenuGroup>
          </>
        }
      />
    </div>
  );
}
