import type { GitStashEntry } from "@ace/protocol";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CheckIcon,
  DotsThreeIcon,
  GitBranchIcon,
  PlusIcon,
} from "@ace/icons";
import { useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { filterBranches, type BranchOption } from "./source-control-model.ts";

/**
 * Top branch bar of the Source control view: branch picker popover (switch/create, search),
 * Pull (with behind count), Push (with ahead count), Fetch, and `⋯` for Stash actions and stash
 * list. Every chrome action is a bare icon with a tooltip.
 */
export function BranchBar(props: {
  branch: string | null;
  ahead: number;
  behind: number;
  branches: readonly BranchOption[];
  branchesLoading: boolean;
  stashes: readonly GitStashEntry[];
  stashesLoading: boolean;
  disabled: boolean;
  /** The thread's agent is working: switching, pulling and stashing wait until it stops. */
  agentWorking: boolean;
  pendingAction: string | undefined;
  onOpenBranches(): void;
  onOpenStashes(): void;
  onSwitchBranch(branch: string, remote?: string): void;
  onCreateBranch(name: string): void;
  onPull(): void;
  onPush(): void;
  onFetch(): void;
  onStash(includeUntracked: boolean): void;
  onPopStash(ref?: string): void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => filterBranches(props.branches, query), [props.branches, query]);
  const busy = props.disabled || props.pendingAction !== undefined;
  const treeLocked = busy || props.agentWorking;
  const waitWords = "Wait for the agent to finish";
  const branchLabel = props.branch ?? "Detached HEAD";

  const pickBranch = (option: BranchOption) => {
    setPickerOpen(false);
    setQuery("");
    if (option.remote || option.name !== props.branch) {
      props.onSwitchBranch(option.name, option.remote);
    }
  };

  const createNew = (name: string) => {
    setPickerOpen(false);
    setQuery("");
    props.onCreateBranch(name);
  };

  return (
    <div
      data-part="source-control-branch-bar"
      className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-1.5"
    >
      <Popover
        open={pickerOpen}
        onOpenChange={(open) => {
          setPickerOpen(open);
          if (open) {
            setQuery("");
            props.onOpenBranches();
          }
        }}
      >
        <PopoverTrigger
          disabled={treeLocked}
          render={
            <BranchButton
              label={`Branch: ${branchLabel}`}
              tip={props.agentWorking ? waitWords : `Switch or create branch (${branchLabel})`}
              className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-sm px-1.5 text-xs font-medium text-foreground transition-colors duration-(--motion-fast) hover:bg-hover focus-ring disabled:opacity-50"
            >
              <Icon icon={GitBranchIcon} size={13} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{branchLabel}</span>
              <Icon icon={CaretDownIcon} size={12} className="shrink-0 text-subtle-foreground" />
            </BranchButton>
          }
        />
        <PopoverContent
          align="start"
          sideOffset={4}
          initialFocus={searchRef}
          className="flex w-64 flex-col p-1.5"
        >
          <Input
            ref={searchRef}
            aria-label="Filter or create branch"
            placeholder="Filter or create branch…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (filtered.locals.length === 1 && !filtered.createName) {
                const only = filtered.locals[0];
                if (only) pickBranch(only);
              } else if (filtered.createName) {
                createNew(filtered.createName);
              } else if (filtered.locals[0]) {
                pickBranch(filtered.locals[0]);
              } else if (filtered.remotes[0]) {
                pickBranch(filtered.remotes[0]);
              }
            }}
            className="h-7 text-xs"
          />
          <div className="mt-1.5 flex max-h-60 flex-col overflow-y-auto overscroll-contain">
            {filtered.createName && (
              <button
                type="button"
                onClick={() => createNew(filtered.createName!)}
                className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs text-foreground hover:bg-hover focus-ring"
              >
                <Icon icon={PlusIcon} size={13} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">Create branch “{filtered.createName}”</span>
              </button>
            )}
            {props.branchesLoading && props.branches.length === 0 && (
              <p className="px-2 py-2 text-xs text-muted-foreground">Reading branches…</p>
            )}
            {filtered.locals.length > 0 && (
              <div className="flex flex-col">
                <span className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-subtle-foreground">
                  Local branches
                </span>
                {filtered.locals.map((item) => (
                  <BranchRow key={item.name} branch={item} onSelect={() => pickBranch(item)} />
                ))}
              </div>
            )}
            {filtered.remotes.length > 0 && (
              <div className="flex flex-col">
                <span className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-subtle-foreground">
                  Remote branches
                </span>
                {filtered.remotes.map((item) => (
                  <BranchRow
                    key={`remote:${item.label}`}
                    branch={item}
                    onSelect={() => pickBranch(item)}
                  />
                ))}
              </div>
            )}
            {!props.branchesLoading &&
              filtered.locals.length === 0 &&
              filtered.remotes.length === 0 &&
              !filtered.createName && (
                <p className="px-2 py-2 text-xs text-muted-foreground">No matching branches.</p>
              )}
          </div>
        </PopoverContent>
      </Popover>

      <div className="flex shrink-0 items-center gap-0.5">
        <SyncAction
          icon={ArrowDownIcon}
          label={
            props.agentWorking
              ? `Pull: ${waitWords.toLowerCase()}`
              : props.behind > 0
                ? `Pull (${props.behind} behind)`
                : "Pull"
          }
          count={props.behind}
          disabled={treeLocked}
          spinning={props.pendingAction === "pull"}
          onClick={props.onPull}
        />
        <SyncAction
          icon={ArrowUpIcon}
          label={props.ahead > 0 ? `Push (${props.ahead} ahead)` : "Push"}
          count={props.ahead}
          disabled={busy}
          spinning={props.pendingAction === "push"}
          onClick={props.onPush}
        />
        <IconButton
          icon={ArrowsClockwiseIcon}
          label="Fetch"
          size="sm"
          disabled={busy}
          onClick={props.onFetch}
          className={cn(
            "size-6 rounded-sm hover:bg-hover",
            props.pendingAction === "fetch" && "[&_svg]:animate-spin",
          )}
        />
        <Menu onOpenChange={(open) => open && props.onOpenStashes()}>
          <MenuTrigger
            render={
              <IconButton
                icon={DotsThreeIcon}
                label="More source control actions"
                tip="More actions"
                size="sm"
                disabled={busy}
                className="size-6 rounded-sm hover:bg-hover"
              />
            }
          />
          <MenuContent align="end" className="w-60">
            <MenuGroup>
              <MenuLabel>Stash</MenuLabel>
              {props.agentWorking && <MenuLabel>{waitWords}</MenuLabel>}
              <MenuItem disabled={props.agentWorking} onClick={() => props.onStash(false)}>
                Stash
              </MenuItem>
              <MenuItem disabled={props.agentWorking} onClick={() => props.onStash(true)}>
                Stash including untracked
              </MenuItem>
              <MenuItem
                disabled={props.agentWorking || props.stashes.length === 0}
                onClick={() => props.onPopStash(undefined)}
              >
                Pop latest stash
              </MenuItem>
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              <MenuLabel>
                Stashes{props.stashes.length > 0 ? ` (${props.stashes.length})` : ""}
              </MenuLabel>
              {props.stashesLoading && props.stashes.length === 0 ? (
                <MenuItem disabled>Reading stashes…</MenuItem>
              ) : props.stashes.length === 0 ? (
                <MenuItem disabled>No stashes</MenuItem>
              ) : (
                props.stashes.map((stash) => (
                  <MenuItem
                    key={stash.ref}
                    disabled={props.agentWorking}
                    onClick={() => props.onPopStash(stash.ref)}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-xs text-foreground">{stash.message}</span>
                      <span className="truncate font-mono text-[11px] text-subtle-foreground">
                        {stash.ref}
                        {stash.branch ? ` · ${stash.branch}` : ""}
                      </span>
                    </span>
                  </MenuItem>
                ))
              )}
            </MenuGroup>
          </MenuContent>
        </Menu>
      </div>
    </div>
  );
}

function BranchButton({
  label,
  tip,
  children,
  ...props
}: React.ComponentProps<"button"> & { label: string; tip: string }) {
  return (
    <Tip label={tip}>
      <button type="button" aria-label={label} {...props}>
        {children}
      </button>
    </Tip>
  );
}

function BranchRow(props: { branch: BranchOption; onSelect(): void }) {
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs text-foreground hover:bg-hover focus-ring"
    >
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
        {props.branch.current && <Icon icon={CheckIcon} size={12} className="text-foreground" />}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", props.branch.current && "font-medium")}>
        {props.branch.label}
      </span>
    </button>
  );
}

/** Pull / Push bare icon button with an optional muted tabular count when ahead or behind. */
function SyncAction(props: {
  icon: typeof ArrowDownIcon;
  label: string;
  count: number;
  disabled: boolean;
  spinning: boolean;
  onClick(): void;
}) {
  return (
    <Tip label={props.label}>
      <button
        type="button"
        aria-label={props.label}
        disabled={props.disabled}
        onClick={props.onClick}
        className={cn(
          "inline-flex h-6 items-center gap-0.5 rounded-sm px-1 text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground focus-ring disabled:pointer-events-none disabled:opacity-40",
          props.count === 0 && "w-6 justify-center px-0",
          props.spinning && "[&_svg]:animate-pulse",
        )}
      >
        <Icon icon={props.icon} size={14} />
        {props.count > 0 && (
          <span className="font-mono text-[11px] leading-none tabular-nums text-muted-foreground">
            {props.count}
          </span>
        )}
      </button>
    </Tip>
  );
}
