import { configuredForges, type ProjectRepository } from "@ace/protocol";
import {
  actionErrorText,
  addRepository,
  hideRepository,
  makePrimary,
  removeRepository,
  repositoryFromAddress,
  repositoryLabel,
  repositoryLine,
  repositoryRefusalText,
  showRepository,
  type RepositoryEdit,
} from "@ace/ui-core";
import { repositoryKey } from "@ace/forge/project-repositories";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ForgeIcon } from "@/components/ui/forge-icon.tsx";
import { Input } from "@/components/ui/input.tsx";
import { listDivider } from "@/components/ui/rules.ts";
import { CommandRefused } from "@/lib/daemon-command.ts";
import { cn } from "@/lib/cn.ts";
import {
  useProjectRepositoryLists,
  useSaveProjectRepositories,
  useSourceControlHosts,
} from "@/lib/project-repositories.ts";

const saveFailure = (error: unknown) =>
  error instanceof CommandRefused
    ? (repositoryRefusalText(error.code) ?? actionErrorText(error.code))
    : "Couldn't save the repositories. Check the connection and try again.";

/**
 * The Git repositories a project uses (ADR 0120): its remotes on known hosts and any added by
 * hand. Each choice is saved at once, apart from the dialog's other fields, and the list shown
 * is always the daemon's answer, never a guess of it.
 */
export function ProjectRepositoriesFields(props: { projectId: string; onLeave(): void }) {
  const lists = useProjectRepositoryLists([props.projectId]);
  const value = lists.lists.get(props.projectId);
  const save = useSaveProjectRepositories();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const config = value?.config ?? null;
  /** Save one edit; a change saved elsewhere meanwhile is read and kept. */
  const apply = async (edit: RepositoryEdit) => {
    if (saving) return false;
    setSaving(true);
    setProblem(undefined);
    try {
      await save(props.projectId, edit, config);
      return true;
    } catch (error) {
      setProblem(saveFailure(error));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const loading = lists.pending.has(props.projectId);
  return (
    <div role="group" aria-label="Repositories" className="grid gap-1.5">
      <h3 className="text-sm font-medium text-muted-foreground">Repositories</h3>
      {value ? (
        value.repositories.length > 0 && (
          <ul className={listDivider}>
            {value.repositories.map((entry) => (
              <RepositoryRow
                key={repositoryKey(entry.repository)}
                entry={entry}
                disabled={saving}
                onLeave={props.onLeave}
                onApply={(change) => void apply((current) => change(current, entry.repository))}
              />
            ))}
          </ul>
        )
      ) : (
        <p className="text-ui text-muted-foreground">
          {loading
            ? "Reading the project's remotes…"
            : "Couldn't read this project's repositories."}
        </p>
      )}
      {value && !value.repositories.length && (
        <p className="text-ui text-muted-foreground">
          No remote of this project is on one of your Git hosts.
        </p>
      )}
      {value && (
        <AddRepository
          disabled={saving}
          onLeave={props.onLeave}
          onAdd={(repository) => apply((current) => addRepository(current, repository))}
        />
      )}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

type Change = typeof hideRepository;

function RepositoryRow(props: {
  entry: ProjectRepository;
  disabled: boolean;
  onApply(change: Change): void;
  onLeave(): void;
}) {
  const { entry } = props;
  const label = repositoryLabel(entry.repository);
  // What fixes these is the host's entry in Source control settings.
  const fixedInSourceControl =
    entry.unavailable === "host_not_configured" || entry.unavailable === "provider_mismatch";
  const action = (text: string, change: Change) => (
    <Button
      size="xs"
      variant="ghost"
      disabled={props.disabled}
      aria-label={`${text}: ${label}`}
      onClick={() => props.onApply(change)}
    >
      {text}
    </Button>
  );
  return (
    <li aria-label={label} className="flex items-center gap-2.5 py-2">
      <ForgeIcon
        forge={entry.repository.forge}
        size={16}
        decorative
        className={cn("shrink-0", !entry.visible && "opacity-50")}
      />
      <div className="grid min-w-0 flex-1">
        <span
          className={cn(
            "flex min-w-0 items-baseline gap-2 text-ui",
            !entry.visible && "text-muted-foreground",
          )}
        >
          <span className="truncate">{label}</span>
          {entry.primary && (
            <span className="shrink-0 text-meta text-muted-foreground">Primary</span>
          )}
        </span>
        <span
          className={cn(
            "text-meta",
            entry.unavailable ? "text-status-needs" : "text-subtle-foreground",
          )}
        >
          {repositoryLine(entry)}
          {fixedInSourceControl && (
            <>
              {". "}
              <Link
                to="/settings/source-control"
                className="text-foreground underline-offset-2 hover:underline"
                onClick={props.onLeave}
              >
                Open Source control
              </Link>
            </>
          )}
        </span>
      </div>
      <div className="flex shrink-0 items-center">
        {!entry.primary && entry.available && action("Make primary", makePrimary)}
        {entry.visible
          ? !entry.primary && action("Hide", hideRepository)
          : action("Show", showRepository)}
        {entry.source === "manual" && action("Remove", removeRepository)}
      </div>
    </li>
  );
}

function AddRepository(props: {
  disabled: boolean;
  onAdd(repository: ProjectRepository["repository"]): Promise<boolean>;
  onLeave(): void;
}) {
  const id = useId();
  const noteId = useId();
  const hosts = useSourceControlHosts();
  const [text, setText] = useState("");
  const parsed =
    hosts.data && text.trim()
      ? repositoryFromAddress(text, configuredForges(hosts.data))
      : undefined;
  const problem = parsed && !parsed.ok ? parsed.problem : undefined;
  const found = parsed?.ok ? parsed.repository : undefined;
  const add = async () => {
    if (!found || props.disabled) return;
    if (await props.onAdd(found)) setText("");
  };
  return (
    <div className="grid gap-1.5 pt-1">
      <label htmlFor={id} className="sr-only">
        Add a repository by address
      </label>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          value={text}
          placeholder="Add a repository: https or SSH address"
          spellCheck={false}
          autoComplete="off"
          disabled={props.disabled}
          aria-invalid={problem ? true : undefined}
          aria-describedby={text.trim() ? noteId : undefined}
          className="font-mono"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // The dialog's form saves on Enter; here Enter adds the repository instead.
            if (event.key !== "Enter") return;
            event.preventDefault();
            void add();
          }}
        />
        <Button size="sm" variant="secondary" disabled={!found || props.disabled} onClick={add}>
          Add
        </Button>
      </div>
      {text.trim() && (
        <p
          id={noteId}
          className={cn("text-sm", problem ? "text-destructive" : "text-subtle-foreground")}
        >
          {hosts.isError
            ? "Couldn't read your Git hosts. Try again in a moment."
            : found
              ? repositoryLabel(found)
              : problem}
          {parsed && !parsed.ok && parsed.reason === "host_not_configured" && (
            <>
              {" "}
              <Link
                to="/settings/source-control"
                className="text-foreground underline-offset-2 hover:underline"
                onClick={props.onLeave}
              >
                Open Source control
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}
