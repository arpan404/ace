import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  RepositoryPublishInput,
  WorkspaceId,
  type RepositoryPublication,
  type SourceControlReadiness,
} from "@ace/protocol";
import { useProjectDirectory } from "@/lib/projects.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.tsx";
import { Footer, Problem, TextField } from "./form-parts.tsx";
import { publicationProblem } from "./publication-copy.ts";

/** Remote writes happen only from Submit; reopening reads the durable publication record. */
export function PublishRepositoryDialog(props: {
  projectId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const machine = usePrimaryMachine();
  const queries = useQueryClient();
  const client = machine.client;
  const project = useProjectDirectory().projects.find((entry) => entry.id === props.projectId);
  const [readiness, setReadiness] = useState<SourceControlReadiness>();
  const [publication, setPublication] = useState<RepositoryPublication | null>();
  const [draft, setDraft] = useState<RepositoryPublishInput>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    void Promise.all([
      client.request(
        { type: "source-control.request", operation: { op: "readiness" } },
        { signal: controller.signal },
      ),
      client.request(
        {
          type: "repositories.request",
          operation: { op: "publication", workspaceId: WorkspaceId.parse(props.projectId) },
        },
        { signal: controller.signal },
      ),
    ])
      .then(([status, record]) => {
        if (controller.signal.aborted) return;
        if (status.result.kind !== "readiness" || record.result.kind !== "publication")
          throw new Error("unavailable");
        const facts = status.result.readiness;
        setReadiness(facts);
        setPublication(record.result.publication);
        if (record.result.publication?.remote)
          void queries.invalidateQueries({ queryKey: ["thread"] });
        setDraft(
          record.result.publication?.input ?? {
            host: facts.preferences.host,
            account: facts.account ?? "",
            owner: facts.account ?? "",
            name: project?.name ?? "",
            description: "",
            visibility: "private",
          },
        );
        setError(undefined);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Couldn't read publication status. Connect to this computer and Refresh status.",
          );
      });
    return () => controller.abort();
    // Refresh status must reread the durable journal even when the client and project are stable.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [client, props.projectId, project?.name, revision, queries]);
  const locked =
    busy || (publication !== undefined && publication !== null && publication.phase !== "prepared");
  const update = (patch: Partial<RepositoryPublishInput>) => {
    if (draft) setDraft({ ...draft, ...patch });
  };
  const publish = async () => {
    if (!client || !draft || busy || publication === undefined) return;
    const parsed = RepositoryPublishInput.safeParse(draft);
    if (!parsed.success) {
      setError(
        "Enter a valid host, account, owner and repository name (up to 100 characters), and description up to 350 characters.",
      );
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.command({
        type: "workspace.publish",
        workspaceId: WorkspaceId.parse(props.projectId),
        input: parsed.data,
      });
      if (result.publication) {
        setPublication(result.publication);
        setDraft(result.publication.input);
      }
      if (result.publication?.remote) void queries.invalidateQueries({ queryKey: ["thread"] });
      if (!result.ok) setError(publicationProblem(result.error ?? "publication_failed"));
    } catch {
      setError(
        "The response was lost. Refresh status or reopen Publish repository to see saved progress, then Resume publication.",
      );
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!client) return;
    try {
      await client.request({
        type: "repositories.request",
        operation: { op: "publication.cancel", workspaceId: WorkspaceId.parse(props.projectId) },
      });
    } catch {
      setError("Couldn't stop publication. Refresh status to see its result.");
    }
  };
  const field = (label: string, key: "account" | "owner" | "name" | "description") => (
    <TextField
      label={label}
      value={draft?.[key] ?? ""}
      onChange={(value) => update({ [key]: value })}
      problem={undefined}
      showProblem={false}
      disabled={locked || !draft}
    />
  );
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent size="lg">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void publish();
          }}
        >
          <DialogHeader>
            <DialogTitle>Publish repository</DialogTitle>
            <DialogDescription>
              Create a GitHub repository for {project?.name ?? "this project"}, add origin and push
              the current branch. Review owner and visibility before publishing.
            </DialogDescription>
          </DialogHeader>
          {draft && readiness && (
            <Select
              label="Publish GitHub host"
              value={draft.host}
              options={readiness.preferences.hosts.map((entry) => ({
                value: entry.host,
                label: entry.host,
              }))}
              onValueChange={(host) =>
                update({
                  host,
                  account:
                    readiness.preferences.hosts.find((entry) => entry.host === host)?.account ?? "",
                })
              }
              disabled={locked}
            />
          )}
          {field("GitHub account", "account")}
          {field("Owner (account or organization)", "owner")}
          {field("Repository name", "name")}
          {field("Description", "description")}
          <Select
            label="Publish visibility"
            value={draft?.visibility ?? "private"}
            options={[
              { value: "private", label: "Private repository" },
              { value: "public", label: "Public repository" },
            ]}
            onValueChange={(visibility) => update({ visibility })}
            disabled={locked || !draft}
          />
          {readiness && readiness.api !== "ready" && (
            <Problem>
              {readiness.instructions} Open Settings → Source control, then Refresh status.
            </Problem>
          )}
          {publication && (
            <div role="status" className="grid gap-2 text-sm">
              <p>Publication: {publication.phase.replaceAll("_", " ")}</p>
              {publication.remote && (
                <a
                  className="text-primary underline"
                  href={publication.remote.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {publication.remote.repository.owner}/{publication.remote.repository.name}
                </a>
              )}
              {publication.phase === "empty" && (
                <p>
                  The repository and origin are ready. This project has no commits. Make your first
                  commit, then Resume publication to push.
                </p>
              )}
              {publication.phase === "pushed" && (
                <p>Current branch pushed. Project Git controls have been refreshed.</p>
              )}
              {publication.error && <Problem>{publicationProblem(publication.error)}</Problem>}
            </div>
          )}
          {error && <Problem>{error}</Problem>}
          <p className="text-sm text-muted-foreground">
            GitHub API access creates the repository. Git push uses this computer's own Git
            credentials. Existing origin is never overwritten. Closing this dialog keeps publication
            running; reopen it to see saved progress.
          </p>
          <Footer closeLabel={busy ? "Hide" : "Close"}>
            {busy && <Button onClick={() => void cancel()}>Stop publication</Button>}
            <Button onClick={() => setRevision((value) => value + 1)} disabled={busy}>
              Refresh status
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                busy ||
                !client ||
                !project ||
                !draft ||
                publication === undefined ||
                readiness?.api !== "ready" ||
                publication?.phase === "pushed"
              }
            >
              {busy
                ? "Publishing…"
                : publication && publication.phase !== "prepared"
                  ? "Resume publication"
                  : "Publish repository"}
            </Button>
          </Footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
