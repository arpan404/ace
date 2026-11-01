import { useConnectionState } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { formatElapsed, type ReadinessTone } from "@ace/ui-core";
import { checkStatusWords, hostChecks, unknownCheck } from "@ace/ui-core/host-care";
import { StatusLine } from "@/components/provider-tile.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useSeconds } from "@/lib/time.ts";
import { useChecksRun } from "./use-checks-run.ts";

export function RunChecks(props: {
  providers: readonly {
    id: string;
    name: string;
    tone: ReadinessTone;
    text: string;
    ready: boolean;
  }[];
}) {
  const ready = useConnectionState() === "ready";
  const { run, since, error, start } = useChecksRun();
  const running = run.state === "running" ? run : undefined;
  const now = useSeconds(running !== undefined);
  const report = run.state === "done" ? run.report : undefined;
  const repairs = run.state === "done" ? (run.repairs ?? []) : [];
  return (
    <>
      <div className="flex min-h-(--setting-row-height) items-center justify-between gap-3 text-ui">
        <span>Check this computer</span>
        <Button
          size="sm"
          variant="secondary"
          disabled={!ready || running !== undefined}
          onClick={() => void start("doctor")}
        >
          {running ? "Checking…" : "Run checks"}
        </Button>
      </div>
      {running && (
        <p role="status" className="text-sm text-muted-foreground">
          {running.operation === "fix"
            ? `Repairing for ${formatElapsed(now - (since ?? now))}.`
            : `Checking for ${formatElapsed(now - (since ?? now))}. You can leave this page; the checks keep running.`}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!!repairs.length && (
        <ul aria-label="Repair results" className="space-y-2 py-2 text-sm">
          {repairs.map((repair) => (
            <li key={repair.id}>
              {repair.status === "fixed" ? "Repaired" : "Needs attention"}: {repair.message}
            </li>
          ))}
        </ul>
      )}
      {report && (
        <ul aria-label="Check results" className="divide-y">
          {report.checks
            .filter((check) => !check.id.startsWith("provider."))
            .map((check) => {
              const info = hostChecks[check.id] ?? unknownCheck;
              return (
                <li key={check.id}>
                  <div className="flex h-8 items-center justify-between gap-2 text-sm">
                    <span>{info.label}</span>
                    <StatusLabel
                      tone={check.status === "ok" ? "done" : "failed"}
                      label={checkStatusWords[check.status]}
                    />
                  </div>
                  <p className="pb-2 text-sm text-muted-foreground">{check.message}</p>
                  {check.status !== "ok" && (
                    <p className="pb-2 text-sm text-muted-foreground">{info.fix}</p>
                  )}
                </li>
              );
            })}
          {props.providers.map((provider) => (
            <li key={provider.id}>
              <div className="flex min-h-8 items-center justify-between gap-2 text-sm">
                <span>{provider.name}</span>
                <StatusLine tone={provider.tone} text={provider.text} />
              </div>
              {!provider.ready && (
                <p className="pb-2 text-sm text-muted-foreground">
                  <Link to="/settings/providers" className="underline underline-offset-2">
                    Open Providers
                  </Link>{" "}
                  to check {provider.name}'s installation and sign-in.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {report?.checks.some((check) => check.status !== "ok") && (
        <div className="flex flex-wrap justify-end gap-2 py-3">
          <Button
            size="sm"
            variant="secondary"
            disabled={!ready || running !== undefined}
            onClick={() => void start("fix")}
          >
            Run safe repairs
          </Button>
        </div>
      )}
    </>
  );
}
