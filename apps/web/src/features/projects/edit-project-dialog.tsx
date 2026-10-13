import type { ProjectDefaults } from "@ace/protocol";
import { projectNameProblem } from "@ace/ui-core";
import { TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { Footer, Problem, TextField } from "./form-parts.tsx";
import { iconChoiceOf, iconEdit, type IconChoice } from "./icon-choice.ts";
import { projectFailure, useProjectCommands } from "./project-commands.ts";
import { ProjectDefaultsFields } from "./project-defaults-fields.tsx";
import { ProjectIconChooser } from "./project-icon-chooser.tsx";
import { ProjectPathRow } from "./project-path-row.tsx";
import type { ProjectRequest } from "./requests.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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
  const toast = useToast();
  const [name, setName] = useState<string>();
  const [icon, setIcon] = useState<IconChoice>();
  const [defaults, setDefaults] = useState<ProjectDefaults>();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const value = name ?? project?.name ?? "";
  const nameProblem = projectNameProblem(value.trim());
  const choice = icon ?? iconChoiceOf(project);

  const save = async () => {
    if (!project || nameProblem || saving) return;
    const edit = {
      name: value.trim(),
      ...(icon ? iconEdit(icon) : {}),
      ...(defaults && !same(defaults, project.defaults ?? {}) ? { defaults } : {}),
    };
    if (Object.keys(edit).length === 1 && edit.name === project.name)
      return props.onOpenChange(false);
    setSaving(true);
    setProblem(undefined);
    try {
      await commands.update(project.id, edit);
      toast.add({ title: `Updated ${edit.name}` });
      props.onOpenChange(false);
    } catch (error) {
      setProblem(projectFailure(error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent size="md">
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
