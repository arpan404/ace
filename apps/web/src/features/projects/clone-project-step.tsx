import { MachineLabel } from "@/components/ui/machine-label.tsx";
import {
  childFolder,
  cloneProgress,
  cloneUrlProblem,
  displayPath,
  freeName,
  parentFolder,
  projectNameProblem,
  repositoryName,
} from "@ace/ui-core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  CommandStepFooter,
  CommandStepRow,
  commandStepField,
  stepFieldKey,
} from "@/components/ui/command-step.tsx";
import { fieldHints } from "@/components/ui/key-hints.tsx";
import { applePlatform } from "@/lib/keymap.ts";
import type { Machine } from "@/lib/machines.ts";
import { Offer, Problem, TextField } from "./form-parts.tsx";
import { LocationField, useLocation } from "./location-field.tsx";
import { projectReads } from "./project-commands.ts";
import type { CloneControl, CloneRun } from "./use-clone-run.ts";
import { useRecentFolders } from "./use-folders.ts";

/**
 * Only GitHub shorthand (`owner/repo`, `github.com/owner/repo`) goes to the daemon to be read.
 * Anything else, a spelled-out address included, is checked here, so nothing with a scheme or
 * a user name in it is sent before Clone.
 */
const shorthand = (value: string) => /^[^\s:@]+\/[^\s:@]+$/.test(value);
const notCloneable =
  "That isn't an address ace can clone. Use https://…, ssh://…, git@host:owner/repo, or owner/repo for GitHub.";

/**
 * The daemon's reading of what was pasted (`workspace.clone.validate`): the address to clone
 * (GitHub `owner/repo` becomes its HTTPS address) and the folder it suggests. Nothing is
 * fetched from the network.
 */
function useCloneAddress(machine: Machine, value: string, enabled: boolean) {
  const client = machine.client;
  return useQuery({
    queryKey: ["projects", "clone-url", machine.id, value],
    queryFn: ({ signal }) => {
      if (!client) throw new Error("offline");
      return projectReads(client).validateClone(value, signal);
    },
    enabled: enabled && client !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/**
 * Add project › Git URL, as a palette step: the field is the repository's address (HTTPS, SSH,
 * git@ or GitHub's owner/repo, checked as you type); below it the folder name and location,
 * suggested beside the machine's latest project. Git uses the person's own credentials on that
 * machine. While it clones, one line shows how far it is with Cancel clone, and it carries on
 * if the palette closes. A failed clone keeps its address, folder name and location in the
 * fields, and Clone tries again with whatever they say then.
 */
export function CloneProjectStep(props: {
  machine: Machine;
  clone: CloneControl;
  initialUrl?: string | undefined;
  onBack: (() => void) | undefined;
  trailing?: ReactNode;
  several: boolean;
}) {
  const { machine, clone } = props;
  const { run, show } = clone;
  useEffect(show, [show]);
  // A clone belongs to the machine it runs on; another machine's step only says it's running.
  const here = run.status !== "idle" && sameMachine(run.machine, machine);
  const failed = run.status === "failed" && here ? run : undefined;
  const elsewhere = run.status === "running" && !here ? run : undefined;
  const previous = failed?.input;
  const [url, setUrl] = useState(props.initialUrl ?? previous?.url ?? "");
  const [name, setName] = useState<string>();
  const [touched, setTouched] = useState(previous !== undefined);
  const only = useMemo(() => [machine], [machine]);
  const latest = useRecentFolders(only).folders[0];
  const place = useLocation({
    machine,
    suggested: previous?.parent ?? (latest ? parentFolder(latest.path) : undefined),
  });
  const running = run.status === "running" && here;
  const value = url.trim();
  const local = value && !shorthand(value) ? cloneUrlProblem(value) : undefined;
  const checked = useCloneAddress(machine, value, value !== "" && shorthand(value));
  const urlProblem = !value
    ? "Paste the repository's address."
    : (local ?? (checked.error ? notCloneable : undefined));
  const parent = running ? run.input.parent : place.location;
  const address = checked.data?.url ?? value;
  const suggestion = checked.data?.name ?? repositoryName(value);
  // The failed clone's folder name stays while its address does; a new address names its own.
  const kept = previous && (value === previous.url || address === previous.url);
  const folder = running
    ? run.input.name
    : (name ?? (kept ? previous.name : freeName(suggestion, place.siblings ?? [])));
  const nameProblem = projectNameProblem(folder, running ? [] : place.siblings);
  const shownUrlProblem = touched && !checked.isFetching ? urlProblem : undefined;
  const leftover =
    failed && place.location === failed.input.parent
      ? leftoverFolder(failed.input.name, place.siblings)
      : undefined;

  const submit = () => {
    setTouched(true);
    if (!parent || urlProblem || nameProblem || running || elsewhere) return;
    clone.dismiss();
    clone.start({ parent, name: folder, url: address }, machine);
  };

  return (
    <form
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || !(applePlatform ? event.metaKey : event.ctrlKey)) return;
        event.preventDefault();
        submit();
      }}
    >
      <CommandStepRow onBack={props.onBack}>
        <input
          aria-label="Repository address"
          aria-invalid={shownUrlProblem ? true : undefined}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- A palette step opens to its field.
          autoFocus
          value={running ? run.input.url : url}
          placeholder="owner/repo or a Git URL"
          spellCheck={false}
          autoComplete="off"
          disabled={running}
          onChange={(event) => {
            setUrl(event.target.value);
            if (event.target.value.trim()) setTouched(true);
          }}
          onKeyDown={(event) =>
            stepFieldKey(event, { text: url, onBack: props.onBack, onClear: () => setUrl("") })
          }
          className={`${commandStepField} font-mono text-sm`}
        />
        {props.trailing}
      </CommandStepRow>
      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto p-4">
        {shownUrlProblem && value && <p className="text-sm text-destructive">{shownUrlProblem}</p>}
        {!running && checked.data && checked.data.url !== value && (
          <p className="font-mono text-xs text-subtle-foreground">{checked.data.url}</p>
        )}
        <TextField
          label="Folder name"
          value={folder}
          onChange={setName}
          placeholder="repo"
          problem={nameProblem}
          // The leftover folder is explained below, with a free name to use instead.
          showProblem={
            touched &&
            folder.toLowerCase() !== leftover?.toLowerCase() &&
            (name !== undefined || kept === true || !urlProblem)
          }
          disabled={running}
        />
        {!running && <LocationField state={place} />}
        {running && run.cancelProblem && <Problem>{run.cancelProblem}</Problem>}
        {failed && <Problem>{failed.problem.message}</Problem>}
        {leftover && place.location && (
          <Offer
            action={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setName(freeName(leftover, place.siblings ?? []))}
              >
                Use {freeName(leftover, place.siblings ?? [])}
              </Button>
            }
          >
            The failed clone left a folder at{" "}
            {displayPath(childFolder(place.location, leftover), place.home?.path)}; ace keeps it for
            you to look at, so clone into another folder name or location.
          </Offer>
        )}
      </div>
      {running ? (
        <CommandStepFooter note={<CloneStatus run={run} several={props.several} />}>
          <Button size="sm" variant="ghost" disabled={run.cancelling} onClick={clone.cancel}>
            Cancel clone
          </Button>
        </CommandStepFooter>
      ) : (
        <CommandStepFooter
          hints={[{ keys: ["enter"], label: "Clone" }, ...fieldHints(url, props.onBack)]}
          note={
            elsewhere ? (
              <span role="status">A clone is running on {elsewhere.machine.name}.</span>
            ) : parent && folder && !nameProblem ? (
              displayPath(childFolder(parent, folder), place.home?.path)
            ) : undefined
          }
        >
          <Button
            type="submit"
            variant="primary"
            disabled={machine.client === undefined || !parent || elsewhere !== undefined}
          >
            Clone
          </Button>
        </CommandStepFooter>
      )}
    </form>
  );
}

const sameMachine = (a: Machine, b: Machine) => a.id === b.id || (a.primary && b.primary);

/** The failed clone's folder, as the location lists it now, when it is still there. */
function leftoverFolder(name: string, siblings: readonly string[] | undefined) {
  const wanted = name.toLowerCase();
  return siblings?.find((sibling) => sibling.toLowerCase() === wanted);
}

/** "https://github.com/acme/web.git" → "acme/web": what a clone line calls the repository. */
function repositoryLabel(url: string, fallback: string): string {
  const parts = url
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter(Boolean);
  return parts.length >= 3 ? parts.slice(-2).join("/") : fallback;
}

/** "Cloning acme/web… 42%": the one line a running clone shows, where Clone was. */
function CloneStatus(props: { run: Extract<CloneRun, { status: "running" }>; several: boolean }) {
  const { run } = props;
  const { value } = cloneProgress(run.phase, run.percent);
  const repository = repositoryLabel(run.input.url, run.input.name);
  return (
    <span role="status" className="font-sans text-ui text-foreground">
      {run.cancelling ? `Cancelling the clone of ${repository}…` : `Cloning ${repository}`}
      {!run.cancelling && props.several && (
        <>
          {" "}
          on{" "}
          <MachineLabel
            name={run.machine.name}
            icon={run.machine.icon}
            primary={run.machine.primary}
          />
        </>
      )}
      {!run.cancelling && `…${value === undefined ? "" : ` ${value}%`}`}
    </span>
  );
}
