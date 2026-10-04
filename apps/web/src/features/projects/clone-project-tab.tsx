import { KeyIcon } from "@phosphor-icons/react";
import {
  childFolder,
  cloneProgress,
  cloneUrlProblem,
  displayPath,
  projectNameProblem,
  repositoryName,
} from "@ace/ui-core";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Footer, LocationField, Problem, TextField } from "./form-parts.tsx";
import type { CloneControl } from "./use-clone-run.ts";
import { useFolderListing, useHostHome } from "./use-folders.ts";

/**
 * Clone repository: an HTTPS, SSH or git@ address, checked as you type, cloned into a folder
 * on the daemon's machine with the person's own Git credentials. Progress comes from Git;
 * Cancel stops it, and a failed sign-in points to the person's Git setup, never to a password
 * field: ace doesn't take credentials.
 */
export function CloneProjectTab(props: { offline: boolean; clone: CloneControl }) {
  const home = useHostHome().data;
  const { run } = props.clone;
  const previous = run.status === "failed" ? run.input : undefined;
  const [url, setUrl] = useState(previous?.url ?? "");
  const [name, setName] = useState<string>();
  const [touched, setTouched] = useState(false);
  const [path, setPath] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const running = run.status === "running";
  const parent = running ? run.input.parent : (selected ?? path ?? previous?.parent ?? home?.path);
  const folder = running ? run.input.name : (name ?? repositoryName(url));
  const siblings = useFolderListing(parent, true).entries?.map((entry) => entry.name);
  const urlProblem = cloneUrlProblem(url.trim());
  const nameProblem = projectNameProblem(folder, running ? [] : siblings);

  const submit = () => {
    setTouched(true);
    if (!parent || urlProblem || nameProblem || running) return;
    props.clone.dismiss();
    props.clone.start({ parent, name: folder, url: url.trim() });
  };

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField
        label="Repository address"
        value={running ? run.input.url : url}
        onChange={(value) => {
          setUrl(value);
          if (value.trim()) setTouched(true);
        }}
        placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git"
        problem={urlProblem}
        showProblem={touched}
        mono
        autoFocus
        disabled={running}
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
            ? `Clones into ${displayPath(childFolder(parent, folder), home?.path)}`
            : undefined
        }
      />
      <LocationField
        path={running ? run.input.parent : (path ?? previous?.parent ?? home?.path)}
        onPath={setPath}
        selected={running ? undefined : selected}
        onSelect={setSelected}
        home={home?.path}
        roots={home?.roots ?? []}
        disabled={running}
      />
      {running ? (
        <CloneProgress
          phase={run.phase}
          percent={run.percent}
          cancelling={run.cancelling}
          onCancel={props.clone.cancel}
        />
      ) : run.status === "failed" ? (
        <Problem>{run.problem.message}</Problem>
      ) : (
        <p className="flex items-start gap-2 text-sm text-subtle-foreground">
          <Icon icon={KeyIcon} size={14} className="mt-px" />
          Git signs in with your own setup on the daemon's machine: its SSH keys and credential
          helper. ace never asks for or stores credentials.
        </p>
      )}
      <Footer
        {...(running
          ? { closeLabel: "Close", note: "The clone carries on if you close this." }
          : {})}
      >
        <Button type="submit" variant="primary" disabled={running || props.offline || !parent}>
          {running ? "Cloning…" : run.status === "failed" ? "Try again" : "Clone"}
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
}) {
  const { label, value } = cloneProgress(props.phase, props.percent);
  return (
    <div className="grid gap-2 rounded-md bg-secondary p-3">
      <div className="flex items-center gap-2 text-ui">
        <Spinner />
        <span className="flex-1 text-foreground" aria-live="polite">
          {props.cancelling ? "Cancelling…" : label}
        </span>
        {value !== undefined && (
          <span className="text-sm text-muted-foreground tabular-nums">{value}%</span>
        )}
        <Button size="sm" variant="ghost" disabled={props.cancelling} onClick={props.onCancel}>
          Cancel clone
        </Button>
      </div>
      <div
        role="progressbar"
        aria-label="Clone progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={value === undefined ? label : `${label}, ${value}%`}
        className="h-1 overflow-hidden rounded-full bg-input"
      >
        <div
          className="h-full origin-left bg-ring transition-transform duration-(--dur-3) ease-smooth"
          style={{ transform: `scaleX(${(value ?? 4) / 100})` }}
        />
      </div>
    </div>
  );
}
