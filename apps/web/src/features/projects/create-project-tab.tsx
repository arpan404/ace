import { childFolder, displayPath, projectNameProblem } from "@ace/ui-core";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { applePlatform } from "@/lib/keymap.ts";
import type { Machine } from "@/lib/machines.ts";
import { Footer, Problem, TextField } from "./form-parts.tsx";
import { gitignoreOptions, gitignoreText, type GitignoreTemplate } from "./gitignore.ts";
import { LocationField, useLocation } from "./location-field.tsx";
import { projectFailure, useProjectCommands, type Added } from "./project-commands.ts";

/** A branch name Git would take, roughly; the daemon runs `git check-ref-format` to be sure. */
function branchProblem(branch: string): string | undefined {
  if (!branch) return undefined;
  if (/\s/.test(branch) || branch.startsWith("-") || branch.includes("..") || branch.endsWith("/"))
    return "That isn't a branch name Git accepts.";
  return undefined;
}

/**
 * New project: a folder in a location on the chosen machine, named with live checks (including
 * a folder already there), optionally made a Git repository on a branch with a starter
 * .gitignore. The location uses the same search and path box as Open folder; ⌘Enter creates.
 */
export function CreateProjectTab(props: {
  machine: Machine;
  machines: readonly Machine[];
  onAdded(result: Added, machine: Machine): void;
}) {
  const { machine } = props;
  const commands = useProjectCommands(machine);
  const place = useLocation({ machine, machines: props.machines });
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
      className="grid gap-4"
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
      <TextField
        label="Name"
        value={name}
        onChange={(value) => {
          setName(value);
          setTouched(true);
        }}
        placeholder="my-app"
        problem={nameProblem}
        showProblem={touched}
        autoFocus
        hint={
          parent && name && !nameProblem
            ? `Creates ${displayPath(childFolder(parent, name), place.home?.path)}`
            : undefined
        }
      />
      <LocationField state={place} several={props.machines.length > 1} disabled={creating} />
      <div className="grid gap-3 rounded-md bg-secondary p-3">
        <div className="flex items-center gap-3">
          <Switch id={gitId} checked={git} onCheckedChange={setGit} />
          <label htmlFor={gitId} className="flex-1 text-ui text-foreground">
            Initialise a Git repository
          </label>
        </div>
        {git && (
          <div className="grid grid-cols-2 gap-3">
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
      <Footer>
        <Button type="submit" variant="primary" disabled={creating || offline || !parent}>
          {creating ? "Creating…" : "Create project"}
          {!creating && <Kbd aria-hidden keys="mod+enter" variant="on-primary" />}
        </Button>
      </Footer>
    </form>
  );
}
