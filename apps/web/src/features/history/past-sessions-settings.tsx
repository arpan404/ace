import { useState } from "react";
import { SettingNote, SettingSection } from "@/components/setting-row.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { SessionRow } from "./session-row.tsx";
import { useFindSessions, useOpenSession } from "./use-past-sessions.ts";

/**
 * Settings → Providers → Past sessions. ace reads a provider's saved sessions only here and
 * only when the person asks; leaving the page discards what was found.
 */
export function PastSessionsSettings() {
  const directory = useProjectDirectory();
  const [selected, setSelected] = useState("");
  const project =
    directory.projects.find((entry) => entry.id === selected) ?? directory.projects[0];
  const { found, find, more } = useFindSessions(project);
  const action = useOpenSession(project);
  return (
    <SettingSection
      label="Past sessions"
      anchor="past-sessions"
      note="Conversations you had in a provider's own app. ace reads them only when you ask, keeps what it finds in memory and forgets it when you leave this page."
    >
      {!project ? (
        <SettingNote>Add a project first. Past sessions are found by project folder.</SettingNote>
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              label="Past sessions project"
              value={project.id}
              options={directory.projects.map((entry) => ({ value: entry.id, label: entry.name }))}
              onValueChange={setSelected}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={found.status === "finding"}
              onClick={find}
            >
              Find past sessions
            </Button>
          </div>
          {found.status === "finding" && (
            <StatusLabel tone="working" label="Looking for past sessions…" />
          )}
          {found.status === "failed" && (
            <p role="alert" className="text-sm text-status-failed">
              Past sessions couldn't be read. Try again in a moment.
            </p>
          )}
          {found.status === "found" && (
            <>
              <p className="text-xs text-muted-foreground">
                Import copies a conversation into ace as a thread. Continue does the same so the
                conversation can be shown, then resumes it in its provider.
              </p>
              {found.sessions.length ? (
                <ul aria-label={`Past sessions in ${project.name}`}>
                  {found.sessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      busy={action.busy}
                      open={(entry, mode) => void action.open(entry, mode)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No past sessions in {project.name} that aren't already in ace.
                </p>
              )}
              {found.next && (
                <Button size="sm" variant="ghost" onClick={more}>
                  Older sessions
                </Button>
              )}
            </>
          )}
          {action.busy && <StatusLabel tone="working" label="Opening session…" />}
          {action.error && (
            <p role="alert" className="text-sm text-status-failed">
              {action.error}
            </p>
          )}
        </div>
      )}
    </SettingSection>
  );
}
