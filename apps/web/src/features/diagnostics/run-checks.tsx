import { useClient, useConnectionState } from "@ace/client-react";
import type { DiagnosticReport } from "@ace/protocol";
import { useState } from "react";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";

const checks: Record<string, { label: string; fix: string }> = {
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
const providers: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  antigravity: "Antigravity",
};

export function RunChecks() {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const [report, setReport] = useState<DiagnosticReport>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const run = async () => {
    setRunning(true);
    setError(undefined);
    try {
      const result = await client.request(
        { type: "diagnostics.request", operation: "doctor" },
        { timeoutMs: 30_000 },
      );
      if (!result.report || result.error) throw new Error();
      setReport(result.report);
    } catch {
      setError("Couldn't finish the checks. Reconnect to this computer and try again.");
    } finally {
      setRunning(false);
    }
  };
  return (
    <>
      <div className="flex h-9 items-center justify-between gap-3 text-ui">
        <span>Check this computer</span>
        <Button size="sm" variant="ghost" disabled={!ready || running} onClick={() => void run()}>
          {running ? "Checking…" : "Run checks"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {report && (
        <ul aria-label="Check results" className="divide-y">
          {report.checks.map((check) => {
            const provider = check.id.startsWith("provider.")
              ? providers[check.id.slice(9)]
              : undefined;
            const info = checks[check.id];
            return (
              <li key={check.id}>
                <div className="flex h-8 items-center justify-between gap-2 text-sm">
                  <span>{provider ?? info?.label ?? "Additional check"}</span>
                  <StatusLabel
                    tone={
                      check.status === "ok"
                        ? "done"
                        : check.status === "warn"
                          ? "waiting"
                          : "failed"
                    }
                    label={
                      check.status === "ok"
                        ? "Passed"
                        : check.status === "warn"
                          ? "Needs attention"
                          : "Needs a fix"
                    }
                  />
                </div>
                {check.status !== "ok" && (
                  <p className="pb-2 text-sm text-muted-foreground">
                    {provider
                      ? `Open Settings › Providers to check ${provider}'s installation and sign-in.`
                      : (info?.fix ??
                        "Update ace and run the checks again. If this continues, export a support bundle.")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
