import { childFolder, displayPath, projectNameProblem } from "@ace/ui-core";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Footer, LocationField, Problem, TextField } from "./form-parts.tsx";
import { gitignoreOptions, gitignoreText, type GitignoreTemplate } from "./gitignore.ts";
import { projectFailure, useProjectCommands, type Added } from "./project-commands.ts";
import { useFolderListing, useHostHome } from "./use-folders.ts";

/** A branch name Git would take, roughly; the daemon runs `git check-ref-format` to be sure. */
function branchProblem(branch: string): string | undefined {
  if (!branch) return undefined;
  if (/\s/.test(branch) || branch.startsWith("-") || branch.includes("..") || branch.endsWith("/"))
    return "That isn't a branch name Git accepts.";
  return undefined;
}

/**
 * Create new: a folder under a location on the daemon's machine, named with live checks
 * (including a folder already there), optionally made a Git repository on a branch with a
 * starter .gitignore.
 */
export function CreateProjectTab(props: { offline: boolean; onAdded(result: Added): void }) {
  const home = useHostHome().data;
  const commands = useProjectCommands();
  const gitId = useId();
  const [path, setPath] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [git, setGit] = useState(true);
  const [branch, setBranch] = useState("");
  const [template, setTemplate] = useState<GitignoreTemplate>("none");
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string>();
  const parent = selected ?? path ?? home?.path;
  const siblings = useFolderListing(parent, true).entries?.map((entry) => entry.name);
  const nameProblem = projectNameProblem(name, siblings);
  const branchIssue = git ? branchProblem(branch.trim()) : undefined;

  const create = async () => {
    setTouched(true);
    if (!parent || nameProblem || branchIssue) return;
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
            ? `Creates ${displayPath(childFolder(parent, name), home?.path)}`
            : undefined
        }
      />
      <LocationField
        path={path ?? home?.path}
        onPath={setPath}
        selected={selected}
        onSelect={setSelected}
        home={home?.path}
        roots={home?.roots ?? []}
        disabled={creating}
      />
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
              placeholder={home?.initialBranch || "main"}
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
        <Button type="submit" variant="primary" disabled={creating || props.offline || !parent}>
          {creating ? "Creating…" : "Create project"}
        </Button>
      </Footer>
    </form>
  );
}
