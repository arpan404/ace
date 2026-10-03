import { useMemo, useState } from "react";
import { Screen } from "@/features/shell/index.ts";
import { Composer, type Draft } from "@/features/thread/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useProjects } from "../use-home-threads.ts";
import { useOrganizerState } from "../use-organizer.ts";
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
  const projects = useProjects().map((p) => p.id);
  const [choices, setChoices] = useState<Choices>(() => loadChoices(storage));
  const [requested, setRequested] = useState(props.project);
  const project = pickProject(projects, requested, choices.project, filter);
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
  // Mentions and uploads complete against the project before the thread exists.
  const draftThread = useMemo(
    () => ({ id: "new", workspaceId: project ?? "", title: "", draft: true }),
    [project],
  );
  const send = async (draft: Draft) => {
    if (sending || !project || !resolved.model) return false;
    choose({ project });
    return create({
      project,
      provider: resolved.model.provider,
      model: resolved.model.fromCatalog ? resolved.model.id : undefined,
      text: draft.text.trim() || "See the attached files.",
      context: { mentions: draft.mentions, attachments: draft.attachments },
    });
  };

  return (
    <Screen title="New thread" subtitle={project}>
      <div className="flex h-full flex-col justify-center overflow-y-auto px-8 pt-8 pb-[12vh]">
        <div className="mx-auto w-full max-w-(--column)">
          <h2 className="mb-5 px-1 text-2xl font-semibold tracking-title text-foreground">
            What should we work on{project ? ` in ${project}` : ""}?
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
                onModel={(model) => choose({ model, account: undefined })}
                onAccount={(account) => choose({ account })}
              />
            }
          />
          <ContextBar
            projects={projects}
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
              No projects yet. A project shows up here once the daemon has a thread in it.
            </p>
          )}
        </div>
      </div>
    </Screen>
  );
}
