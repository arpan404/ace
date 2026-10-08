import type { HistoryListRequest } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import { useDeferredValue, useState } from "react";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import type { Project } from "@/lib/projects.ts";
import { SessionRow } from "./session-row.tsx";
import { useOpenSession, usePastSessions } from "./use-past-sessions.ts";

export default function SessionsDialog(props: { project: Project; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const [before, setBefore] = useState<HistoryListRequest["before"]>();
  const deferred = useDeferredValue(search);
  const query = usePastSessions(props.project, {
    limit: 100,
    search: deferred,
    ...(before ? { before } : {}),
  });
  const action = useOpenSession(props.project);
  const sessions = query.data?.sessions.filter((s) => s.support.status === "supported") ?? [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Past sessions</DialogTitle>
          <DialogDescription>Saved conversations in {props.project.name}</DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Search past sessions"
          placeholder="Search past sessions"
          value={search}
          onValueChange={(value) => {
            setSearch(value);
            setBefore(undefined);
          }}
        />
        <DialogBody>
          {query.isError ? (
            <p role="alert">Past sessions couldn't be loaded. Reconnect and try again.</p>
          ) : !query.data ? (
            <StatusLabel tone="working" label="Loading past sessions…" />
          ) : !sessions.length ? (
            <p className="text-sm text-muted-foreground">No matching sessions.</p>
          ) : (
            (["claude", "codex", "opencode", "cursor"] as const).map((provider) => {
              const group = sessions.filter((s) => s.provider === provider);
              return group.length ? (
                <section key={provider}>
                  <h3 className="text-xs text-muted-foreground">{providerNames[provider]}</h3>
                  <ul aria-label={`${providerNames[provider]} sessions`}>
                    {group.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        busy={action.busy}
                        open={(entry, mode) => void action.open(entry, mode)}
                      />
                    ))}
                  </ul>
                </section>
              ) : null;
            })
          )}
          {query.isError && (
            <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          )}
          {query.data?.next && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setBefore(query.data?.next ?? undefined)}
            >
              Older sessions
            </Button>
          )}
          {before && (
            <Button variant="ghost" size="sm" onClick={() => setBefore(undefined)}>
              Latest sessions
            </Button>
          )}
        </DialogBody>
        {action.busy && <StatusLabel tone="working" label="Opening session…" />}
        {action.error && (
          <p role="alert" className="text-sm text-status-failed">
            {action.error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
