import { ProjectIconField, projectIconProblem } from "./project-icon-field.tsx";
import { MachineLabel } from "@/components/ui/machine-label.tsx";
import { ArrowClockwiseIcon, KeyIcon } from "@phosphor-icons/react";
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
import { useMemo, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { ProgressBar } from "@/components/ui/progress-bar.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { applePlatform } from "@/lib/keymap.ts";
import type { Machine } from "@/lib/machines.ts";
import { Footer, Problem, TextField } from "./form-parts.tsx";
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
 * Clone: an HTTPS, SSH or git@ address, or GitHub's owner/repo, checked as you type and cloned
 * with the person's own Git credentials into a folder on the chosen machine. The destination is
 * suggested (beside the machine's latest project, named after the repository and free there).
 * Progress shows inline with Cancel; a failed clone offers Retry. ace never takes credentials.
 */
export function CloneProjectTab(props: {
  machine: Machine;
  machines: readonly Machine[];
  clone: CloneControl;
}) {
  const { machine, clone } = props;
  const { run } = clone;
  const previous = run.status === "failed" ? run.input : undefined;
  const [url, setUrl] = useState(previous?.url ?? "");
  const [name, setName] = useState<string>();
  const [icon, setIcon] = useState<string | null | undefined>(previous?.icon);
  const [iconBusy, setIconBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const only = useMemo(() => [machine], [machine]);
  const latest = useRecentFolders(only).folders[0];
  const place = useLocation({
    machine,
    machines: props.machines,
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

  const submit = () => {
    setTouched(true);
    if (!parent || urlProblem || nameProblem || running || iconBusy || projectIconProblem(icon))
      return;
    clone.dismiss();
    clone.start(
      { parent, name: folder, url: address, ...(icon === undefined ? {} : { icon }) },
      machine,
    );
  };

  return (
    <form
      noValidate
      className="grid gap-4"
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
      <TextField
        label="Repository address"
        value={running ? run.input.url : url}
        onChange={(next) => {
          setUrl(next);
          if (next.trim()) setTouched(true);
        }}
        placeholder="owner/repo, https://github.com/owner/repo.git or git@host:owner/repo.git"
        problem={urlProblem}
        showProblem={touched && !checked.isFetching}
        mono
        autoFocus
        disabled={running}
        hint={
          !running && checked.data && checked.data.url !== value
            ? `Clones ${checked.data.url}`
            : undefined
        }
      />
      <TextField
        label="Folder name"
        value={folder}
        onChange={setName}
        placeholder="repo"
        problem={nameProblem}
        showProblem={touched && (name !== undefined || !urlProblem)}
        disabled={running}
        hint={
          parent && folder && !nameProblem
            ? `Clones into ${displayPath(childFolder(parent, folder), place.home?.path)}`
            : undefined
        }
      />
      <ProjectIconField
        name={folder}
        value={running ? run.input.icon : icon}
        onChange={setIcon}
        onBusy={setIconBusy}
        disabled={running}
      />
      {!running && <LocationField state={place} several={props.machines.length > 1} />}
      {running ? (
        <>
          <CloneProgress
            phase={run.phase}
            percent={run.percent}
            cancelling={run.cancelling}
            onCancel={clone.cancel}
            machine={props.machines.length > 1 ? run.machine : undefined}
          />
          {run.cancelProblem && <Problem>{run.cancelProblem}</Problem>}
        </>
      ) : run.status === "failed" ? (
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
      ) : (
        <p className="flex items-start gap-2 text-sm text-subtle-foreground">
          <Icon icon={KeyIcon} size={14} className="mt-px" />
          Git signs in with your own setup on that machine: its SSH keys and credential helper. ace
          never asks for or stores credentials.
        </p>
      )}
      <Footer
        {...(running
          ? { closeLabel: "Hide", note: "The clone carries on while this is hidden." }
          : {})}
      >
        <Button
          type="submit"
          variant="primary"
          disabled={
            running ||
            machine.client === undefined ||
            !parent ||
            iconBusy ||
            !!projectIconProblem(icon)
          }
        >
          {running ? "Cloning…" : "Clone"}
          {!running && <Kbd aria-hidden keys="mod+enter" variant="on-primary" />}
        </Button>
      </Footer>
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
              · on <MachineLabel name={props.machine.name} icon={props.machine.icon} />
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
