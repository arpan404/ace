import type { ProjectDefaults, ProjectNoteEdit } from "@ace/protocol";
import {
  projectEdit,
  projectIconChoice,
  projectNameProblem,
  savedProjectNotes,
} from "@ace/ui-core";
import { TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectDirectory } from "@/lib/projects.ts";
import { verifyRunsKey } from "@/lib/verify.ts";
import { Footer, Problem, TextField } from "./form-parts.tsx";
import type { IconChoice } from "./icon-choice.ts";
import { projectFailure, useProjectCommands } from "./project-commands.ts";
import { ProjectBrowserProfile } from "./project-browser-profile.tsx";
import { ProjectDefaultsFields } from "./project-defaults-fields.tsx";
import { ProjectIconChooser } from "./project-icon-chooser.tsx";
import { ProjectNotesFields } from "./project-notes-fields.tsx";
import { ProjectPathRow } from "./project-path-row.tsx";
import type { ProjectRequest } from "./requests.ts";

/**
 * A project's name, icon and new-thread defaults, saved together through the daemon so every
 * device shows them. The folder on disk is never renamed or touched; Remove leaves it there.
 */
export function EditProjectDialog(props: {
  projectId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onRequest(request: ProjectRequest): void;
}) {
  const project = useProjectDirectory().projects.find((each) => each.id === props.projectId);
  const commands = useProjectCommands();
  const cache = useQueryClient();
  const [name, setName] = useState<string>();
  const [icon, setIcon] = useState<IconChoice>();
  const [defaults, setDefaults] = useState<ProjectDefaults>();
  const [notes, setNotes] = useState<ProjectNoteEdit[]>();
  const savedNotes = savedProjectNotes(project);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const value = name ?? project?.name ?? "";
  const nameProblem = projectNameProblem(value.trim());
  const choice = icon ?? projectIconChoice(project);

  const save = async () => {
    if (!project || nameProblem || saving) return;
    const result = projectEdit(project, { name: value, icon, defaults, notes });
    if (result.kind === "invalid") return;
    if (result.kind === "unchanged") return props.onOpenChange(false);
    const edit = result.edit;
    setSaving(true);
    setProblem(undefined);
    try {
      await commands.update(project.id, edit);
      // Verify answers with the command its runs use: read it again once it may have changed.
      if (edit.defaults?.checkCommand !== project.defaults?.checkCommand)
        void cache.invalidateQueries({ queryKey: verifyRunsKey(project.id) });
      props.onOpenChange(false);
    } catch (error) {
      setProblem(projectFailure(error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit project</DialogTitle>
          </DialogHeader>
          {project ? (
            <div className="grid gap-4">
              <div className="grid gap-1.5">
                <TextField
                  label="Name"
                  value={value}
                  onChange={setName}
                  problem={nameProblem}
                  showProblem={name !== undefined}
                  autoFocus
                  disabled={saving}
                />
                <ProjectPathRow path={project.path} />
              </div>
              <ProjectIconChooser
                project={project}
                name={value}
                choice={choice}
                onChange={setIcon}
                disabled={saving}
              />
              <ProjectDefaultsFields
                projectId={project.id}
                value={defaults ?? project.defaults ?? {}}
                onChange={setDefaults}
              />
              <ProjectBrowserProfile
                value={defaults ?? project.defaults ?? {}}
                onChange={setDefaults}
              />
              <ProjectNotesFields
                value={notes ?? savedNotes}
                onChange={setNotes}
                disabled={saving}
              />
            </div>
          ) : (
            <Problem>That project is gone.</Problem>
          )}
          {problem && <Problem>{problem}</Problem>}
          <Footer
            note={
              project && (
                <Button
                  variant="ghost"
                  tone="danger"
                  size="sm"
                  onClick={() => props.onRequest({ kind: "remove", projectId: project.id })}
                >
                  <Icon icon={TrashIcon} />
                  Remove project…
                </Button>
              )
            }
          >
            <Button type="submit" variant="primary" disabled={!project || saving || !!nameProblem}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </Footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
