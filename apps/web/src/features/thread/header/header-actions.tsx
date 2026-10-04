import {
  ArrowSquareOutIcon,
  CodeIcon,
  CursorIcon,
  FileCodeIcon,
  GitCommitIcon,
  GitDiffIcon,
  GitPullRequestIcon,
  LightningIcon,
  PaperPlaneTiltIcon,
  PlayIcon,
  UploadSimpleIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { ThreadReader } from "@ace/client";
import { useClient, useThread } from "@ace/client-react";
import { nextGitStep, prBlocker, type GitStep } from "@ace/ui-core";
import { useMutation } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { launchEditor } from "@/boot/editor-launch.ts";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { SplitButton } from "@/components/ui/split-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { findRunningTerminal } from "@/features/panels/index.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useEditors } from "@/lib/editors.ts";
import { keymap } from "@/lib/keymap.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useCheckoutState, useGitActions, type GitChange } from "../lib/use-git.ts";
import { useTaskKeys } from "../lib/use-task-keys.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import type { Script } from "../sources/workspace-source.ts";
import type { GitDialogKind } from "./git-dialog.tsx";

// Loaded on first open: the thread route's first paint doesn't need the commit or PR form.
const GitDialog = lazy(() => import("./git-dialog.tsx").then((m) => ({ default: m.GitDialog })));

const failure = (error: unknown) =>
  error instanceof Error ? error.message : "The daemon couldn't do that.";

interface Shell {
  id: string;
  command: string;
}
/** The agents' background shells still running, by the command they run. */
const runningShells = (reader: ThreadReader): Shell[] =>
  reader.taskIds().flatMap((id) => {
    const task = reader.task(id);
    return task?.kind === "shell" && task.status === "running"
      ? [{ id, command: task.title.trim() }]
      : [];
  });
const sameShells = (a: readonly Shell[], b: readonly Shell[]) =>
  a.length === b.length && a.every((shell, i) => shell.id === b[i]?.id);
const noShells: readonly Shell[] = [];

/**
 * Run ▶: the project's first script, or another from the picker, in a bottom terminal. A script
 * still running goes back to its terminal (or the agent's background shell running the same
 * command) instead of starting a second copy. While the scripts load, fail to load or don't
 * exist, the caret's menu says so.
 */
export function RunButton(props: { thread: ThreadRef }) {
  const sources = useThreadSources();
  const client = useClient();
  const toast = useToast();
  const workspace = useWorkspaceActions(props.thread.id);
  const shells =
    useThread(props.thread.id, useTaskKeys(props.thread.id), runningShells, sameShells) ?? noShells;
  const query = useDaemonQuery({
    queryKey: ["thread", "scripts", props.thread.id],
    staleTime: 60_000,
    retry: false,
    read: (_client, signal) => sources.workspace.scripts(props.thread, signal),
  });
  const scripts = query.data;
  const first = scripts?.[0];
  // The bottom panel opening on the script's terminal is the confirmation.
  const run = async (script: Script) => {
    try {
      // An agent already runs it in the background: show that shell rather than a second copy
      // fighting it for the same port.
      const agentShell = shells.find((shell) => shell.command === script.command.trim());
      // The workspace's agent-shell and terminal tabs (features/panels/terminal/tabs.ts).
      if (agentShell) return workspace.open({ kind: "shell", id: agentShell.id });
      const running = await findRunningTerminal(client, props.thread.id, script.name);
      const terminalId = running?.id ?? (await sources.workspace.runScript(props.thread, script));
      workspace.open({ kind: "terminal", id: terminalId, title: script.name });
    } catch (error) {
      toast.add({ title: `Couldn't run ${script.command}`, description: failure(error) });
    }
  };
  // Loading, unreadable or none: the caret's menu says which, so a click always explains.
  const note = query.isPending
    ? ["Loading scripts", "They show here once the daemon has read them"]
    : query.isError
      ? ["Couldn't read this project's scripts", "Try again, or check the daemon's log"]
      : first
        ? undefined
        : ["No scripts in this project", "Add one to package.json and it shows here"];
  return (
    <SplitButton
      variant="ghost"
      icon={<PlayIcon aria-hidden size={16} />}
      actionLabel={first ? `Run ${first.command}` : (note?.[0] ?? "")}
      menuLabel="Choose a script"
      actionDisabled={!first && !query.isPending}
      onAction={() => first && void run(first)}
      menu={
        note ? (
          <>
            <MenuItem disabled reason={note[1]}>
              {note[0]}
            </MenuItem>
            {query.isError && <MenuItem onClick={() => void query.refetch()}>Try again</MenuItem>}
          </>
        ) : (
          scripts?.map((script, index) => (
            <MenuItem
              key={script.id}
              icon={<PlayIcon aria-hidden size={16} />}
              onClick={() => void run(script)}
            >
              <span className="font-mono text-[12px]">{script.command}</span>
              {index === 0 && <span className="ml-3 text-xs text-subtle-foreground">default</span>}
            </MenuItem>
          ))
        )
      }
    />
  );
}

const editorIcons: Record<string, PhosphorIcon> = {
  code: CodeIcon,
  cursor: CursorIcon,
  zed: LightningIcon,
};

/** Open: the checkout in this device's default editor; the picker changes the default. */
export function OpenButton(props: { thread: ThreadRef }) {
  const sources = useThreadSources();
  const toast = useToast();
  const { editors, current, choose } = useEditors();
  const open = useMutation({
    mutationFn: async (editorId: string) => {
      const launch = await sources.workspace.openIn(props.thread, editorId);
      await launchEditor({
        editorId: launch.editor.id,
        editorName: launch.editor.name,
        path: launch.path,
      });
      return launch.editor;
    },
    onSuccess: (editor) => {
      choose(editor.id);
      toast.add({ title: `Opened in ${editor.name}` });
    },
    onError: (error) =>
      toast.add({ title: "Couldn't open the editor", description: error.message }),
  });
  const Glyph = editorIcons[current?.id ?? ""] ?? FileCodeIcon;
  return (
    <SplitButton
      icon={<Glyph aria-hidden size={16} className="text-foreground" />}
      label="Open"
      actionLabel={
        current
          ? `Open the checkout in ${current.name}`
          : "No editors found on the daemon's machine"
      }
      menuLabel="Choose an editor"
      disabled={!current || open.isPending}
      onAction={() => current && open.mutate(current.id)}
      menu={editors?.map((editor) => {
        const Icon = editorIcons[editor.id] ?? FileCodeIcon;
        return (
          <MenuItem
            key={editor.id}
            icon={<Icon aria-hidden size={16} />}
            onClick={() => open.mutate(editor.id)}
          >
            {editor.name}
            {editor.id === current?.id && (
              <span className="ml-3 text-xs text-subtle-foreground">default</span>
            )}
          </MenuItem>
        );
      })}
    />
  );
}

function openUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

const stepLabel = (step: GitStep) =>
  step.kind === "commit"
    ? "Commit"
    : step.kind === "push"
      ? "Push"
      : step.kind === "create-pr"
        ? "Create PR"
        : `PR #${step.pr.number}`;

const stepIcon = (step: GitStep) =>
  step.kind === "commit" ? (
    <GitCommitIcon aria-hidden size={16} />
  ) : step.kind === "push" ? (
    <UploadSimpleIcon aria-hidden size={16} />
  ) : (
    <GitPullRequestIcon aria-hidden size={16} />
  );

const ci: Record<string, string> = {
  pending: "checks running",
  success: "checks passed",
  failure: "checks failed",
};

/**
 * Commit, disabled, while the checkout loads or when there is none: the header keeps its shape
 * instead of shifting when the read lands.
 */
function GitPlaceholder(props: { actionLabel: string }) {
  return (
    <SplitButton
      icon={<GitCommitIcon aria-hidden size={16} />}
      label="Commit"
      actionLabel={props.actionLabel}
      menuLabel="Git actions"
      disabled
      actionDisabled
      onAction={() => undefined}
      menu={null}
    />
  );
}

/** Commit → Push → Create PR → PR #N: the next step towards a merged change. */
export function GitButton(props: { thread: ThreadRef }) {
  const { checkout, state } = useCheckoutState(props.thread);
  const { change, pending } = useGitActions(props.thread, checkout);
  const [dialog, setDialog] = useState<GitDialogKind>();
  const toast = useToast();
  const workspace = useWorkspaceActions(props.thread.id);
  if (!checkout)
    return (
      <GitPlaceholder
        actionLabel={
          props.thread.draft
            ? "Nothing to commit yet"
            : state === "loading"
              ? "Reading the checkout"
              : "Not a git checkout"
        }
      />
    );
  const step = nextGitStep(checkout);
  const blocked = prBlocker(checkout);
  const submit = async (next: GitChange) => {
    const number = await change(next);
    toast.add({
      title:
        next.kind === "commit"
          ? next.push
            ? "Committed and pushed"
            : "Committed"
          : next.kind === "push"
            ? "Pushed"
            : `${next.draft ? "Draft pull request" : "Pull request"} #${number ?? ""} opened`,
    });
  };
  const push = () =>
    void submit({ kind: "push" }).catch((error: unknown) =>
      toast.add({ title: "Couldn't push", description: failure(error) }),
    );
  const pr = checkout.pr;
  const draftBlocked =
    blocked ??
    (pr?.state === "open" || pr?.state === "draft"
      ? `PR #${pr.number} is already open`
      : undefined);
  const actionLabel =
    step.kind === "pr"
      ? `Open PR #${step.pr.number}${step.pr.ci && ci[step.pr.ci] ? ` · ${ci[step.pr.ci]}` : ""}`
      : step.kind === "create-pr" && step.blocked
        ? step.blocked
        : `${stepLabel(step)} this branch`;
  return (
    <>
      <SplitButton
        icon={stepIcon(step)}
        label={stepLabel(step)}
        actionLabel={actionLabel}
        menuLabel="Git actions"
        disabled={pending}
        actionDisabled={step.kind === "create-pr" && !!step.blocked}
        onAction={() => {
          if (step.kind === "pr") {
            if (step.pr.url) openUrl(step.pr.url);
          } else if (step.kind === "push") push();
          else if (step.kind === "commit") setDialog("commit");
          else if (!step.blocked) setDialog("pr");
        }}
        menu={
          <>
            <MenuItem
              icon={<GitCommitIcon aria-hidden size={16} />}
              disabled={checkout.changed === 0}
              onClick={() => setDialog("commit")}
            >
              Commit…
            </MenuItem>
            <MenuItem
              icon={<PaperPlaneTiltIcon aria-hidden size={16} />}
              disabled={checkout.changed === 0}
              onClick={() => setDialog("commit-push")}
            >
              Commit &amp; push…
            </MenuItem>
            <MenuItem
              icon={<UploadSimpleIcon aria-hidden size={16} />}
              disabled={!checkout.branch}
              onClick={push}
            >
              Push
            </MenuItem>
            <MenuItem
              icon={<GitPullRequestIcon aria-hidden size={16} />}
              disabled={!!draftBlocked}
              reason={draftBlocked}
              onClick={() => setDialog("draft-pr")}
            >
              Create draft PR…
            </MenuItem>
            {pr && (
              <MenuItem
                icon={<ArrowSquareOutIcon aria-hidden size={16} />}
                disabled={!pr.url}
                reason={pr.url ? undefined : "The forge gave no address for it"}
                onClick={() => pr.url && openUrl(pr.url)}
              >
                Open PR #{pr.number}
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem
              icon={<GitDiffIcon aria-hidden size={16} />}
              keys={keymap.changes.keys}
              onClick={() => workspace.open({ kind: "changes" })}
            >
              View diff
            </MenuItem>
          </>
        }
      />
      {dialog && (
        <Suspense fallback={null}>
          <GitDialog
            kind={dialog}
            title={props.thread.title}
            checkout={checkout}
            pending={pending}
            onSubmit={submit}
            onClose={() => setDialog(undefined)}
          />
        </Suspense>
      )}
    </>
  );
}
