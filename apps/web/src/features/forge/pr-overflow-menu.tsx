import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSidebarAll } from "@ace/client-react";
import { mergeMethods, type MergeMethod } from "@ace/ui-core";
import { prUrl } from "@ace/forge/pr-reference";
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CopyIcon,
  DotsThreeIcon,
  EyeIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  HashIcon,
  LinkBreakIcon,
  LinkIcon,
  PencilSimpleIcon,
  PlusIcon,
  QueueIcon,
  TimerIcon,
  UserPlusIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { openExternal } from "@/boot/open-external.ts";
import type { PrWorkspaceExtensions } from "./pr-extensions.ts";
import type { PrActions } from "./pr-actions.ts";
import { lifecycleLabels } from "./pr-lifecycle.ts";

const icon = (Glyph: typeof LinkIcon) => <Glyph aria-hidden size={16} />;

/** The tasks of this project, for linking the PR or checking it out in one. */
function useProjectTasks(workspaceId: string) {
  return (
    useSidebarAll((reader) =>
      reader.ids.flatMap((id) => {
        const thread = reader.thread(id);
        return thread?.workspaceId === workspaceId ? [{ id, title: thread.title }] : [];
      }),
    ) ?? []
  );
}

/**
 * Everything the PR panel can do besides its primary control, in five groups: tasks and
 * refresh, state changes, the merge method, links, and the destructive actions at the bottom.
 */
export function PrOverflowMenu(props: {
  actions: PrActions;
  extensions?: PrWorkspaceExtensions | undefined;
  hostThreadId?: string | undefined;
  refreshing: boolean;
  onRefresh(): void;
  onEdit(): void;
  onRevert(): void;
  onRequestReview(): void;
}) {
  const { actions } = props;
  const { context, lifecycle, mergeState, writes, worktree } = actions;
  const { detail } = context;
  const { status } = detail;
  const toast = useToast();
  const navigate = useNavigate();
  const tasks = useProjectTasks(context.workspaceId);
  const [closing, setClosing] = useState(false);
  const related = detail.relatedThreads;
  const hostId = props.hostThreadId;
  // The panel's own task, when it is one this device knows.
  const host = useSidebarAll((reader) => (hostId && reader.thread(hostId) ? hostId : undefined));
  const hostLinked = host !== undefined && related.some((t) => t.id === host);
  const unlinked = tasks.filter((task) => !related.some((t) => t.id === task.id));
  const writeTask = related.find((t) => t.id === actions.threadId);
  const open = status.state === "open" || status.state === "draft";
  const lifecycleReason = lifecycle.query.isError
    ? "Couldn't read what GitHub allows: refresh"
    : lifecycle.unresolved.length
      ? "Check the previous change's result first"
      : lifecycle.blocked
        ? "Wait for GitHub to refresh"
        : undefined;
  const apply = (kind: "ready" | "draft" | "reopen" | "update.merge" | "update.rebase") =>
    void lifecycle.apply({ kind });
  const copy = (text: string) =>
    void navigator.clipboard
      ?.writeText(text)
      .catch(() =>
        toast.error({ title: "Couldn't copy", description: "Clipboard access is blocked." }),
      );
  const openOnGitHub = (url: string) =>
    void openExternal(url).catch(() => toast.error({ title: "Couldn't open GitHub" }));
  const lifecycleItem = (
    kind: "ready" | "draft" | "reopen" | "update.merge" | "update.rebase",
    glyph: typeof LinkIcon,
  ) =>
    lifecycle.can(kind) && (
      <MenuItem
        icon={icon(glyph)}
        disabled={lifecycleReason !== undefined}
        reason={lifecycleReason}
        onClick={() => apply(kind)}
      >
        {lifecycleLabels[kind]}
      </MenuItem>
    );
  return (
    <Menu onOpenChange={(next) => !next && setClosing(false)}>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label="Pull request actions"
            className="size-6 px-0"
          />
        }
      >
        {props.refreshing ? <Spinner /> : <DotsThreeIcon aria-hidden size={16} />}
      </MenuTrigger>
      <MenuContent align="end" className="w-72">
        <MenuGroup>
          {host && !hostLinked && (
            <MenuItem
              icon={icon(LinkIcon)}
              disabled={writes.pending}
              onClick={() => void writes.link(host)}
            >
              Link to this task
            </MenuItem>
          )}
          {unlinked.length > 0 && (
            <MenuSub>
              <MenuSubTrigger icon={icon(LinkIcon)}>Link to a task</MenuSubTrigger>
              <MenuContent className="max-h-80 w-64 overflow-y-auto">
                {unlinked.map((task) => (
                  <MenuItem key={task.id} onClick={() => void writes.link(task.id)}>
                    {task.title}
                  </MenuItem>
                ))}
              </MenuContent>
            </MenuSub>
          )}
          {related.length > 0 && (
            <MenuSub>
              <MenuSubTrigger icon={icon(GitBranchIcon)}>
                {`Linked tasks (${related.length}${detail.relatedThreadsTruncated ? "+" : ""})`}
              </MenuSubTrigger>
              <MenuContent className="max-h-80 w-64 overflow-y-auto">
                {related.map((task) => (
                  <MenuItem
                    key={task.id}
                    onClick={() =>
                      void navigate({ to: "/t/$threadId", params: { threadId: task.id } })
                    }
                  >
                    {task.archived ? `${task.title} · Archived` : task.title}
                  </MenuItem>
                ))}
              </MenuContent>
            </MenuSub>
          )}
          {writeTask && (
            <MenuItem
              icon={icon(LinkBreakIcon)}
              disabled={writes.pending}
              onClick={() => void writes.unlink(writeTask.id)}
            >
              {hostLinked ? "Unlink from this task" : `Unlink from ${writeTask.title}`}
            </MenuItem>
          )}
          <MenuItem icon={icon(ArrowClockwiseIcon)} onClick={props.onRefresh}>
            Refresh
          </MenuItem>
          <MenuItem
            icon={icon(PlusIcon)}
            onClick={() =>
              void navigate({
                to: "/new",
                search: { project: context.workspaceId, pullRequest: status.url },
              })
            }
          >
            Work on PR in a new task
          </MenuItem>
          {host && tasks.some((task) => task.id === host) ? (
            <MenuItem
              icon={icon(GitPullRequestIcon)}
              disabled={worktree.blocked !== undefined}
              reason={worktree.blocked}
              onClick={() => void worktree.prepare(host)}
            >
              Work on PR in this task
            </MenuItem>
          ) : (
            tasks.length > 0 && (
              <MenuSub>
                <MenuSubTrigger icon={icon(GitPullRequestIcon)}>
                  Work on PR in a task
                </MenuSubTrigger>
                <MenuContent className="max-h-80 w-64 overflow-y-auto">
                  {tasks.map((task) => (
                    <MenuItem
                      key={task.id}
                      disabled={worktree.blocked !== undefined}
                      onClick={() => void worktree.prepare(task.id)}
                    >
                      {task.title}
                    </MenuItem>
                  ))}
                </MenuContent>
              </MenuSub>
            )
          )}
          {status.state === "open" && actions.threadId && (
            <MenuItem
              icon={icon(UserPlusIcon)}
              disabled={writes.fenced || context.disabled}
              onClick={props.onRequestReview}
            >
              Request review…
            </MenuItem>
          )}
          {lifecycle.snapshot && lifecycle.snapshot.editableFields.length > 0 && (
            <MenuItem icon={icon(PencilSimpleIcon)} onClick={props.onEdit}>
              Edit details…
            </MenuItem>
          )}
          {props.extensions?.overflow?.(context)}
        </MenuGroup>
        {open && (
          <>
            <MenuSeparator />
            <MenuGroup>
              {lifecycleItem("ready", EyeIcon)}
              {lifecycleItem("draft", EyeIcon)}
              {actions.primary.kind !== "merge" && status.state === "open" && (
                <MenuItem
                  icon={icon(GitMergeIcon)}
                  disabled={actions.mergeBlocked !== undefined}
                  reason={actions.mergeBlocked}
                  onClick={() => void writes.merge(actions.method)}
                >
                  Merge now
                </MenuItem>
              )}
              {mergeState.state?.autoMerge ? (
                <MenuItem
                  icon={icon(TimerIcon)}
                  disabled={mergeState.blocked !== undefined || !mergeState.state.canDisable}
                  reason={mergeState.blocked}
                  onClick={() => void mergeState.run("disable", actions.method)}
                >
                  Disable auto-merge
                </MenuItem>
              ) : (
                status.state === "open" && (
                  <MenuItem
                    icon={icon(TimerIcon)}
                    disabled={actions.autoMergeBlocked !== undefined}
                    reason={actions.autoMergeBlocked}
                    onClick={() => void mergeState.run("enable", actions.method)}
                  >
                    Enable auto-merge
                  </MenuItem>
                )
              )}
              {mergeState.state?.queue && (
                <MenuItem
                  icon={icon(QueueIcon)}
                  disabled={mergeState.blocked !== undefined || !mergeState.state.canDequeue}
                  reason={mergeState.blocked}
                  onClick={() => void mergeState.run("dequeue", actions.method)}
                >
                  Leave merge queue
                </MenuItem>
              )}
              {lifecycleItem("update.merge", GitBranchIcon)}
              {lifecycleItem("update.rebase", GitBranchIcon)}
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              <MenuLabel>Merge method</MenuLabel>
              <MenuRadioGroup
                value={actions.method}
                onValueChange={(value: MergeMethod) => actions.setMethod(value)}
              >
                {mergeMethods.map((choice) => (
                  <MenuRadioItem key={choice.method} value={choice.method} closeOnClick={false}>
                    {choice.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        )}
        <MenuSeparator />
        <MenuGroup>
          <MenuItem
            icon={icon(ArrowSquareOutIcon)}
            keys="o"
            resolve={false}
            onClick={() => openOnGitHub(status.url)}
          >
            Open on GitHub
          </MenuItem>
          <MenuItem
            icon={icon(CopyIcon)}
            keys="c"
            resolve={false}
            onClick={() =>
              copy(
                `gh pr checkout ${status.ref.number} --repo ${status.ref.repository.host}/${status.ref.repository.owner}/${status.ref.repository.name}`,
              )
            }
          >
            Copy checkout command
          </MenuItem>
          <MenuItem icon={icon(CopyIcon)} onClick={() => copy(status.url)}>
            Copy link
          </MenuItem>
          <MenuItem icon={icon(HashIcon)} onClick={() => copy(`#${status.ref.number}`)}>
            Copy number
          </MenuItem>
          {lifecycle.revertPrs.map((ref) => (
            <MenuItem
              key={ref.number}
              icon={icon(ArrowSquareOutIcon)}
              onClick={() => openOnGitHub(prUrl(ref))}
            >
              {`Open revert PR #${ref.number}`}
            </MenuItem>
          ))}
        </MenuGroup>
        {(lifecycle.can("close") || lifecycle.can("reopen") || lifecycle.can("revert")) && (
          <>
            <MenuSeparator />
            <MenuGroup>
              {lifecycle.can("close") && (
                <MenuItem
                  danger
                  icon={icon(XCircleIcon)}
                  closeOnClick={closing}
                  disabled={lifecycleReason !== undefined}
                  reason={lifecycleReason}
                  onClick={() => {
                    if (!closing) return setClosing(true);
                    setClosing(false);
                    void lifecycle.apply({ kind: "close" });
                  }}
                >
                  {closing ? "Confirm close?" : lifecycleLabels.close}
                </MenuItem>
              )}
              {lifecycleItem("reopen", ArrowCounterClockwiseIcon)}
              {lifecycle.can("revert") && (
                <MenuItem
                  danger
                  icon={icon(ArrowCounterClockwiseIcon)}
                  disabled={lifecycleReason !== undefined}
                  reason={lifecycleReason}
                  onClick={props.onRevert}
                >
                  {`${lifecycleLabels.revert}…`}
                </MenuItem>
              )}
            </MenuGroup>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}
