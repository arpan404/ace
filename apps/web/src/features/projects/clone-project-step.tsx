import { MachineLabel } from "@/components/ui/machine-label.tsx";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
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
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  CommandStepFooter,
  CommandStepRow,
  commandStepField,
  stepFieldKey,
} from "@/components/ui/command-step.tsx";
import { backHint, escapeHint } from "@/components/ui/key-hints.tsx";
import { ProgressBar } from "@/components/ui/progress-bar.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { applePlatform } from "@/lib/keymap.ts";
import type { Machine } from "@/lib/machines.ts";
import { Problem, TextField } from "./form-parts.tsx";
import { LocationField, useLocation } from "./location-field.tsx";
import { projectReads } from "./project-commands.ts";
import type { CloneControl } from "./use-clone-run.ts";
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
 * machine. Progress shows inline with Cancel and carries on if the palette closes; a failed
 * clone offers Retry.
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
  const previous = run.status === "failed" ? run.input : undefined;
  const [url, setUrl] = useState(props.initialUrl ?? previous?.url ?? "");
  const [name, setName] = useState<string>();
  const [touched, setTouched] = useState(false);
  const only = useMemo(() => [machine], [machine]);
  const latest = useRecentFolders(only).folders[0];
  const place = useLocation({
    machine,
    suggested: previous?.parent ?? (latest ? parentFolder(latest.path) : undefined),
  });
  const running = run.status === "running";
  const value = url.trim();
  const local = value && !shorthand(value) ? cloneUrlProblem(value) : undefined;
  const checked = useCloneAddress(machine, value, value !== "" && shorthand(value));
  const urlProblem = !value
    ? "Paste the repository's address."
    : (local ?? (checked.error ? notCloneable : undefined));
  const parent = running ? run.input.parent : place.location;
  const suggestion = checked.data?.name ?? repositoryName(value);
  const folder = running ? run.input.name : (name ?? freeName(suggestion, place.siblings ?? []));
  const nameProblem = projectNameProblem(folder, running ? [] : place.siblings);
  const address = checked.data?.url ?? value;
  const shownUrlProblem = touched && !checked.isFetching ? urlProblem : undefined;

  const submit = () => {
    setTouched(true);
    if (!parent || urlProblem || nameProblem || running) return;
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
          showProblem={touched && (name !== undefined || !urlProblem)}
          disabled={running}
        />
        {!running && <LocationField state={place} />}
        {running ? (
          <>
            <CloneProgress
              phase={run.phase}
              percent={run.percent}
              cancelling={run.cancelling}
              onCancel={clone.cancel}
              machine={props.several ? run.machine : undefined}
            />
            {run.cancelProblem && <Problem>{run.cancelProblem}</Problem>}
          </>
        ) : (
          run.status === "failed" && (
            <Problem
              action={
                <Button size="sm" onClick={clone.retry}>
                  <Icon icon={ArrowClockwiseIcon} size={14} />
                  Retry
                </Button>
              }
            >
              {run.problem.message}
            </Problem>
          )
        )}
      </div>
      <CommandStepFooter
        hints={[
          { keys: ["enter"], label: "Clone" },
          ...(props.onBack ? [backHint] : []),
          escapeHint(url),
        ]}
        note={
          parent && folder && !nameProblem
            ? displayPath(childFolder(parent, folder), place.home?.path)
            : undefined
        }
      >
        <Button
          type="submit"
          variant="primary"
          disabled={running || machine.client === undefined || !parent}
        >
          {running ? "Cloning…" : "Clone"}
        </Button>
      </CommandStepFooter>
    </form>
  );
}

function CloneProgress(props: {
  phase: Parameters<typeof cloneProgress>[0];
  percent: number | undefined;
  cancelling: boolean;
  onCancel(): void;
  machine: Machine | undefined;
}) {
  const { label, value } = cloneProgress(props.phase, props.percent);
  return (
    <div className="grid gap-2 rounded-md bg-secondary p-3">
      <div className="flex items-center gap-2 text-ui">
        <Spinner />
        <span className="flex-1 text-foreground" aria-live="polite">
          {props.cancelling ? "Cancelling…" : label}
          {props.machine && (
            <span className="text-subtle-foreground">
              {" "}
              · on{" "}
              <MachineLabel
                name={props.machine.name}
                icon={props.machine.icon}
                primary={props.machine.primary}
              />
            </span>
          )}
        </span>
        {value !== undefined && (
          <span className="text-sm text-muted-foreground tabular-nums">{value}%</span>
        )}
        <Button size="sm" variant="ghost" disabled={props.cancelling} onClick={props.onCancel}>
          Cancel clone
        </Button>
      </div>
      <ProgressBar
        label="Clone progress"
        value={value}
        valueText={value === undefined ? label : `${label}, ${value}%`}
      />
    </div>
  );
}
