import { useMemo, useState } from "react";
import { Screen } from "@/features/shell/index.ts";
import { Composer, useDraftScope, type Draft } from "@/features/thread/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useProjectChoices } from "@/lib/projects.ts";
import { useOrganizerState } from "@/features/organize/index.ts";
import { loadChoices, pickProject, resolve, saveChoices, type Choices } from "./choices.ts";
import { ContextBar } from "./context-bar.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { useBranches } from "./branch-source.ts";
import { useNewThreadOptions } from "@/features/models/index.ts";
import { useCreateThread } from "./use-create-thread.ts";

/**
 * ⌘N: pick a project, a model and account, a worktree or the local checkout, and describe the
 * work. The thread is created when the message is sent, then opens.
 */
export function NewThreadPage(props: { project?: string | undefined; base?: string | undefined }) {
  const { storage } = useLayout();
  const { project: filter } = useOrganizerState();
  const { ids: projects, name } = useProjectChoices();
  const [choices, setChoices] = useState<Choices>(() => loadChoices(storage));
  const [requested, setRequested] = useState(props.project);
  const project = pickProject(projects, requested, choices.project, filter);
  const projectName = project === undefined ? undefined : name(project);
  const [baseChoice, setBase] = useState(props.base);
  const { create, sending, error } = useCreateThread();

  const options = useNewThreadOptions();
  const resolved = resolve(options, choices);
  const branches = useBranches(project);
  const base = baseChoice && branches.includes(baseChoice) ? baseChoice : branches[0];

  const choose = (patch: Partial<Choices>) => {
    const next = { ...choices, ...patch };
    setChoices(next);
    saveChoices(storage, next);
  };
  // Mentions and uploads go to a draft scope on the daemon before the thread exists; the new
  // thread adopts it. A draft ref's id is that scope.
  const scope = useDraftScope(project);
  const draftThread = useMemo(
    () => ({ id: scope.draftId ?? "", workspaceId: project ?? "", title: "", draft: true }),
    [scope.draftId, project],
  );
  const send = async (draft: Draft) => {
    if (sending || !project || !resolved.model) return false;
    choose({ project });
    const draftId = scope.draftId;
    const created = await create({
      project,
      provider: resolved.model.provider,
      model: resolved.model.fromCatalog ? resolved.model.id : undefined,
      account: resolved.account?.id,
      mode: resolved.mode,
      baseBranch: base,
      effort: resolved.effort,
      text: draft.text.trim() || "See the attached files.",
      context: {
        ...(draftId ? { draftId } : {}),
        mentions: draft.mentions,
        attachments: draft.attachments,
      },
    });
    if (created) scope.adopt();
    return created;
  };

  return (
    <Screen title="New thread" subtitle={projectName}>
      <div className="flex h-full flex-col justify-center overflow-y-auto px-8 pt-8 pb-[12vh]">
        <div className="mx-auto w-full max-w-(--column)">
          <h2 className="mb-5 px-1 text-2xl font-semibold tracking-title text-foreground">
            What should we work on{projectName ? ` in ${projectName}` : ""}?
          </h2>
          <Composer
            thread={draftThread}
            busy={false}
            onSubmit={send}
            autoFocus
            placeholder="Describe the change, a bug, or a question. @ to mention a file"
            controls={
              <ModelPicker
                options={options}
                resolved={resolved}
                onModel={(model) => choose({ model, account: undefined, effort: undefined })}
                onAccount={(account) => choose({ account })}
                onEffort={(effort) => choose({ effort })}
              />
            }
          />
          <ContextBar
            projects={projects}
            projectName={name}
            project={project}
            onProject={(next) => {
              setRequested(next);
              setBase(undefined);
              choose({ project: next });
            }}
            mode={resolved.mode}
            onMode={(mode) => choose({ mode })}
            branches={branches}
            base={base}
            onBase={setBase}
          />
          {error && (
            <p role="alert" className="mt-3 px-2 text-ui text-status-failed">
              {error}
            </p>
          )}
          {!projects.length && (
            <p className="mt-3 px-2 text-ui text-muted-foreground">
              This daemon has no projects yet.
            </p>
          )}
        </div>
      </div>
    </Screen>
  );
}
