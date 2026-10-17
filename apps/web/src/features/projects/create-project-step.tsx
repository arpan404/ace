import { childFolder, displayPath, parentFolder, projectNameProblem } from "@ace/ui-core";
import { useId, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  CommandStepFooter,
  CommandStepRow,
  commandStepField,
  stepFieldKey,
} from "@/components/ui/command-step.tsx";
import { backHint, escapeHint } from "@/components/ui/key-hints.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { applePlatform } from "@/lib/keymap.ts";
import type { Machine } from "@/lib/machines.ts";
import { Problem, TextField } from "./form-parts.tsx";
import { gitignoreOptions, gitignoreText, type GitignoreTemplate } from "./gitignore.ts";
import { LocationField, useLocation } from "./location-field.tsx";
import { projectFailure, useProjectCommands, type Added } from "./project-commands.ts";
import { useRecentFolders } from "./use-folders.ts";

/** A branch name Git would take, roughly; the daemon runs `git check-ref-format` to be sure. */
function branchProblem(branch: string): string | undefined {
  if (!branch) return undefined;
  if (/\s/.test(branch) || branch.startsWith("-") || branch.includes("..") || branch.endsWith("/"))
    return "That isn't a branch name Git accepts.";
  return undefined;
}

/**
 * Add project › New project, as a palette step: the field is the new folder's name (checked
 * live, a folder already there included); below it the location (beside the machine's latest
 * project to start with) and an optional Git repository with its branch and .gitignore.
 * Enter or ⌘Enter creates.
 */
export function CreateProjectStep(props: {
  machine: Machine;
  onBack: (() => void) | undefined;
  onAdded(result: Added, machine: Machine): void;
  trailing?: ReactNode;
}) {
  const { machine } = props;
  const commands = useProjectCommands(machine);
  const only = useMemo(() => [machine], [machine]);
  const latest = useRecentFolders(only).folders[0];
  const place = useLocation({
    machine,
    suggested: latest ? parentFolder(latest.path) : undefined,
  });
  const gitId = useId();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [git, setGit] = useState(true);
  const [branch, setBranch] = useState("");
  const [template, setTemplate] = useState<GitignoreTemplate>("none");
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string>();
  const parent = place.location;
  const nameProblem = projectNameProblem(name, place.siblings);
  const branchIssue = git ? branchProblem(branch.trim()) : undefined;
  const offline = machine.client === undefined;

  const create = async () => {
    setTouched(true);
    if (!parent || nameProblem || branchIssue || creating) return;
    setCreating(true);
    setProblem(undefined);
    const ignore = git ? gitignoreText(template) : undefined;
    try {
      props.onAdded(
        await commands.create({
          parent,
          name,
          ...(git ? { git: branch.trim() ? { initialBranch: branch.trim() } : {} } : {}),
          ...(ignore ? { gitignore: ignore } : {}),
        }),
        machine,
      );
    } catch (error) {
      setProblem(projectFailure(error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <form
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || !(applePlatform ? event.metaKey : event.ctrlKey)) return;
        event.preventDefault();
        void create();
      }}
    >
      <CommandStepRow onBack={props.onBack}>
        <input
          aria-label="Project name"
          aria-invalid={touched && nameProblem ? true : undefined}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- A palette step opens to its field.
          autoFocus
          value={name}
          placeholder="New project name"
          spellCheck={false}
          autoComplete="off"
          disabled={creating}
          onChange={(event) => {
            setName(event.target.value);
            setTouched(true);
          }}
          onKeyDown={(event) =>
            stepFieldKey(event, { text: name, onBack: props.onBack, onClear: () => setName("") })
          }
          className={commandStepField}
        />
        {props.trailing}
      </CommandStepRow>
      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto p-4">
        {touched && nameProblem && name && (
          <p className="text-sm text-destructive">{nameProblem}</p>
        )}
        <LocationField state={place} disabled={creating} />
        <div className="grid gap-3 rounded-md bg-secondary p-3">
          <div className="flex items-center gap-3">
            <Switch id={gitId} checked={git} onCheckedChange={setGit} />
            <label htmlFor={gitId} className="flex-1 text-ui text-foreground">
              Initialise a Git repository
            </label>
          </div>
          {git && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField
                label="Initial branch"
                value={branch}
                onChange={setBranch}
                placeholder={place.home?.initialBranch || "main"}
                problem={branchIssue}
                showProblem
                mono
              />
              <div className="grid content-start gap-1.5">
                <span className="text-sm font-medium text-muted-foreground">.gitignore</span>
                <Select<GitignoreTemplate>
                  label=".gitignore template"
                  value={template}
                  options={gitignoreOptions}
                  onValueChange={setTemplate}
                />
              </div>
            </div>
          )}
        </div>
        {problem && <Problem>{problem}</Problem>}
      </div>
      <CommandStepFooter
        hints={[
          { keys: ["enter"], label: "Create" },
          ...(props.onBack ? [backHint] : []),
          escapeHint(name),
        ]}
        note={
          parent && name && !nameProblem
            ? displayPath(childFolder(parent, name), place.home?.path)
            : undefined
        }
      >
        <Button type="submit" variant="primary" disabled={creating || offline || !parent}>
          {creating ? "Creating…" : "Create project"}
        </Button>
      </CommandStepFooter>
    </form>
  );
}
