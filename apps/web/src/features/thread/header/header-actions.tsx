import {
  CheckIcon,
  CodeIcon,
  CursorIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitDiffIcon,
  GitPullRequestIcon,
  HammerIcon,
  LightningIcon,
  PaperPlaneTiltIcon,
  PencilSimpleIcon,
  PlayIcon,
  TerminalWindowIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { SplitButton } from "@/components/ui/split-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { keymap } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useGit } from "../lib/use-git.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import { nextGitStep, type EditorId, type GitAction } from "../sources/workspace-source.ts";

const editorIcons: Record<EditorId, PhosphorIcon> = {
  cursor: CursorIcon,
  vscode: CodeIcon,
  zed: LightningIcon,
  xcode: HammerIcon,
  finder: FolderOpenIcon,
  terminal: TerminalWindowIcon,
};

/** Run ▶: the project's default script, or another from the picker, in the bottom terminal. */
export function RunButton(props: { thread: ThreadRef }) {
  const sources = useThreadSources();
  const toast = useToast();
  const { setTab, setPanelOpen } = useLayout();
  const scripts = useQuery({
    queryKey: ["thread", "scripts", props.thread.workspaceId],
    queryFn: () => sources.workspace.scripts(props.thread),
  }).data;
  const first = scripts?.[0];
  const run = (script: { name: string; command: string }) => {
    setTab("bottom", "terminal");
    setPanelOpen("bottom", true);
    sources.workspace.runScript(props.thread, script).then(
      () => toast.add({ title: `Running ${script.command}` }),
      () => toast.add({ title: `Couldn't run ${script.command}` }),
    );
  };
  return (
    <SplitButton
      variant="ghost"
      icon={<PlayIcon aria-hidden size={16} />}
      actionLabel={first ? `Run ${first.command}` : "Run"}
      menuLabel="Choose a script"
      disabled={!first}
      onAction={() => first && run(first)}
      menu={
        <>
          {scripts?.map((script, index) => (
            <MenuItem
              key={script.name}
              icon={<PlayIcon aria-hidden size={16} />}
              onClick={() => run(script)}
            >
              <span className="font-mono text-[12px]">{script.command}</span>
              {index === 0 && <span className="ml-3 text-xs text-subtle-foreground">default</span>}
            </MenuItem>
          ))}
        </>
      }
    />
  );
}

/** Open: the checkout in the default editor; the picker changes the default. */
export function OpenButton(props: { thread: ThreadRef }) {
  const sources = useThreadSources();
  const toast = useToast();
  const queryClient = useQueryClient();
  const editors = useQuery({
    queryKey: ["editors"],
    queryFn: () => sources.workspace.editors(),
  }).data;
  const open = useMutation({
    mutationFn: (id: EditorId) => sources.workspace.openIn(props.thread, id),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: ["editors"] });
      const name = editors?.editors.find((editor) => editor.id === id)?.name ?? id;
      toast.add({ title: `Opened in ${name}` });
    },
    onError: () => toast.add({ title: "Couldn't open the editor" }),
  });
  const current = editors?.editors.find((editor) => editor.id === editors.defaultEditor);
  const Glyph = editorIcons[current?.id ?? "cursor"];
  return (
    <SplitButton
      icon={<Glyph aria-hidden size={16} className="text-foreground" />}
      label="Open"
      actionLabel={`Open the checkout in ${current?.name ?? "your editor"}`}
      menuLabel="Choose an editor"
      disabled={!current}
      onAction={() => current && open.mutate(current.id)}
      menu={editors?.editors.map((editor) => {
        const Icon = editorIcons[editor.id];
        return (
          <MenuItem
            key={editor.id}
            icon={<Icon aria-hidden size={16} />}
            onClick={() => open.mutate(editor.id)}
          >
            {editor.name}
            {editor.id === editors.defaultEditor && (
              <span className="ml-3 text-xs text-subtle-foreground">default</span>
            )}
          </MenuItem>
        );
      })}
    />
  );
}

function openPr(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

const done: Record<GitAction, string> = {
  commit: "Committed · the agent wrote the message",
  "commit-push": "Committed and pushed",
  push: "Pushed",
  "create-pr": "Pull request opened",
  "create-draft-pr": "Draft pull request opened",
};

/** Commit → Push → Create PR → PR #N: the next step towards a merged change. */
export function GitButton(props: { thread: ThreadRef }) {
  const { git, change, pending } = useGit(props.thread);
  const toast = useToast();
  const { setTab, setPanelOpen } = useLayout();
  if (!git) return null;
  const step = nextGitStep(git);
  const act = (action: GitAction) =>
    change({ kind: "action", action }).then(
      () => toast.add({ title: done[action] }),
      () => toast.add({ title: "Git couldn't finish that", description: "Nothing was changed." }),
    );
  return (
    <SplitButton
      icon={
        "pr" in step ? (
          <GitPullRequestIcon aria-hidden size={16} />
        ) : step.action === "create-pr" ? (
          <CheckIcon aria-hidden size={16} />
        ) : (
          <GitBranchIcon aria-hidden size={16} />
        )
      }
      label={"pr" in step ? `PR #${step.pr.number}` : step.label}
      actionLabel={"pr" in step ? `Open PR #${step.pr.number}` : `${step.label} this branch`}
      menuLabel="Git actions"
      disabled={pending}
      onAction={() => ("pr" in step ? openPr(step.pr.url) : void act(step.action))}
      menu={
        <>
          <MenuItem
            icon={<PencilSimpleIcon aria-hidden size={16} />}
            disabled={git.changed === 0}
            onClick={() => void act("commit")}
          >
            Commit
          </MenuItem>
          <MenuItem
            icon={<PaperPlaneTiltIcon aria-hidden size={16} />}
            disabled={git.changed === 0 && git.ahead === 0}
            onClick={() => void act("commit-push")}
          >
            Commit &amp; push
          </MenuItem>
          <MenuItem
            icon={<GitPullRequestIcon aria-hidden size={16} />}
            disabled={!!git.pr}
            onClick={() => void act("create-draft-pr")}
          >
            Create draft PR
          </MenuItem>
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
  );
}
