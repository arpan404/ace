import { DoctorTriage } from "@/features/triage/index.ts";
import { useClient, useConnectionState } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import type { ReadinessTone } from "@ace/ui-core";
import { StatusLine } from "@/components/provider-tile.tsx";

import { catalogKey } from "@/lib/model-catalog.ts";
import { refreshProviders } from "@/lib/provider-readiness.ts";
import { useQueryClient } from "@tanstack/react-query";
import type { DiagnosticReport, DiagnosticRepair } from "@ace/protocol";
import { useState } from "react";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";

const checks: Record<string, { label: string; fix: string }> = {
  "home.permissions": {
    label: "Data folder access",
    fix: "Run safe repairs, or restore owner access to the ace data folder.",
  },
  "logs.directory": {
    label: "Log folder",
    fix: "Run safe repairs to create the log folder or restore owner access.",
  },
  node: { label: "App runtime", fix: "Update ace and restart it." },
  git: { label: "Git", fix: "Install Git. On a Mac, install the Xcode Command Line Tools." },
  "node-pty": { label: "Terminal", fix: "Reinstall ace, then try opening a terminal again." },
  chromium: { label: "Browser", fix: "Install Chrome or Chromium to use the browser tools." },
  disk: {
    label: "Storage",
    fix: "Free some disk space and check that ace can read and write its data folder.",
  },
  sqlite: {
    label: "Saved conversations",
    fix: "Quit ace and back up its data folder before restoring a known-good backup.",
  },
  "remote.openssl": {
    label: "Secure connections",
    fix: "Install OpenSSL to use secure remote connections.",
  },
};

export function RunChecks(props: {
  providers: readonly {
    id: string;
    name: string;
    tone: ReadinessTone;
    text: string;
    ready: boolean;
  }[];
}) {
  const client = useClient();
  const queries = useQueryClient();
  const ready = useConnectionState() === "ready";
  const [report, setReport] = useState<DiagnosticReport>();
  const [repairs, setRepairs] = useState<DiagnosticRepair[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (operation: "doctor" | "fix") => {
    setRunning(true);
    setError(undefined);
    try {
      const result = await client.request(
        { type: "diagnostics.request", operation },
        { timeoutMs: 30_000 },
      );
      if (!result.report || result.error) throw new Error();
      setReport(result.report);
      setRepairs(result.repairs ?? []);
      await client.request({ type: "providers.request", operation: "refresh" });
      // Discovery includes installed ACP agents as well as the built-in providers.
      await client.request({ type: "models.refresh", filter: {} }, { timeoutMs: 30_000 });
      await queries.invalidateQueries({ queryKey: catalogKey });
      refreshProviders(queries);
      setReport(result.report);
    } catch {
      setError("Couldn't finish the checks. Reconnect to this computer and try again.");
    } finally {
      setRunning(false);
    }
  };
  return (
    <>
      <div className="flex min-h-(--setting-row-height) items-center justify-between gap-3 text-ui">
        <span>Check this computer</span>
        <Button
          size="sm"
          variant="secondary"
          disabled={!ready || running}
          onClick={() => void run("doctor")}
        >
          {running ? "Checking…" : "Run checks"}
        </Button>
      </div>
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
              const info = checks[check.id];
              return (
                <li key={check.id}>
                  <div className="flex h-8 items-center justify-between gap-2 text-sm">
                    <span>{info?.label ?? "Additional check"}</span>
                    <StatusLabel
                      tone={check.status === "ok" ? "done" : "failed"}
                      label={
                        check.status === "ok"
                          ? "Passed"
                          : check.status === "warn"
                            ? "Needs attention"
                            : "Needs a fix"
                      }
                    />
                  </div>
                  <p className="pb-2 text-sm text-muted-foreground">{check.message}</p>
                  {check.status !== "ok" && (
                    <p className="pb-2 text-sm text-muted-foreground">
                      {info?.fix ??
                        "Update ace and run the checks again. If this continues, export a support bundle."}
                    </p>
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
            disabled={!ready || running}
            onClick={() => void run("fix")}
          >
            Run safe repairs
          </Button>
          <DoctorTriage report={report} />
        </div>
      )}
    </>
  );
}
