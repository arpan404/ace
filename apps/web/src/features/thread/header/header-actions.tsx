import {
  ArrowSquareOutIcon,
  CheckIcon,
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
import { useClient } from "@ace/client-react";
import { nextGitStep, prBlocker, type GitStep } from "@ace/ui-core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { launchEditor } from "@/boot/editor-launch.ts";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { SplitButton } from "@/components/ui/split-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { revealTerminal } from "@/features/panels/index.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useEditors } from "@/lib/editors.ts";
import { keymap } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useCheckout, useGitActions, type GitChange } from "../lib/use-git.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import type { Script } from "../sources/workspace-source.ts";
import { GitDialog, type GitDialogKind } from "./git-dialog.tsx";

const failure = (error: unknown) =>
  error instanceof Error ? error.message : "The daemon couldn't do that.";

/** Run ▶: the project's first script, or another from the picker, in a new bottom terminal. */
export function RunButton(props: { thread: ThreadRef }) {
  const sources = useThreadSources();
  const client = useClient();
  const toast = useToast();
  const { setTab, setPanelOpen } = useLayout();
  const scripts = useDaemonQuery({
    queryKey: ["thread", "scripts", props.thread.id],
    staleTime: 60_000,
    retry: false,
    read: (_client, signal) => sources.workspace.scripts(props.thread, signal),
  }).data;
  const first = scripts?.[0];
  const run = (script: Script) => {
    sources.workspace.runScript(props.thread, script).then(
      (terminalId) => {
        setTab("bottom", "terminal");
        setPanelOpen("bottom", true);
        void revealTerminal(client, props.thread.id, terminalId);
        toast.add({ title: `Running ${script.command}` });
      },
      (error: unknown) =>
        toast.add({ title: `Couldn't run ${script.command}`, description: failure(error) }),
    );
  };
  return (
    <SplitButton
      variant="ghost"
      icon={<PlayIcon aria-hidden size={16} />}
      actionLabel={first ? `Run ${first.command}` : "No scripts in this project"}
      menuLabel="Choose a script"
      disabled={!first}
      onAction={() => first && run(first)}
      menu={scripts?.map((script, index) => (
        <MenuItem
          key={script.id}
          icon={<PlayIcon aria-hidden size={16} />}
          onClick={() => run(script)}
        >
          <span className="font-mono text-[12px]">{script.command}</span>
          {index === 0 && <span className="ml-3 text-xs text-subtle-foreground">default</span>}
        </MenuItem>
      ))}
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
  ) : step.kind === "create-pr" ? (
    <CheckIcon aria-hidden size={16} />
  ) : (
    <GitPullRequestIcon aria-hidden size={16} />
  );

const ci: Record<string, string> = {
  pending: "checks running",
  success: "checks passed",
  failure: "checks failed",
};

/** Commit → Push → Create PR → PR #N: the next step towards a merged change. */
export function GitButton(props: { thread: ThreadRef }) {
  const checkout = useCheckout(props.thread);
  const { change, pending } = useGitActions(props.thread, checkout);
  const [dialog, setDialog] = useState<GitDialogKind>();
  const toast = useToast();
  const { setTab, setPanelOpen } = useLayout();
  if (!checkout) return null;
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
              disabled={!!blocked || pr?.state === "open" || pr?.state === "draft"}
              onClick={() => setDialog("draft-pr")}
            >
              Create draft PR…
            </MenuItem>
            {pr?.url && (
              <MenuItem
                icon={<ArrowSquareOutIcon aria-hidden size={16} />}
                onClick={() => pr.url && openUrl(pr.url)}
              >
                Open PR #{pr.number}
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem
              icon={<GitDiffIcon aria-hidden size={16} />}
              keys={keymap.changes.keys}
              onClick={() => {
                setTab("right", "changes");
                setPanelOpen("right", true);
              }}
            >
              View diff
            </MenuItem>
          </>
        }
      />
      {dialog && (
        <GitDialog
          kind={dialog}
          title={props.thread.title}
          checkout={checkout}
          pending={pending}
          onSubmit={submit}
          onClose={() => setDialog(undefined)}
        />
      )}
    </>
  );
}
