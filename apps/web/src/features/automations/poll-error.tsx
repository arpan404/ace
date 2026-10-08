import type { AutomationPollError } from "@ace/protocol";
import { StatusLabel } from "@/components/status-label.tsx";

/** Stored diagnostics become a fix in words, without exposing CLI output or error codes. */
function fixHint(message: string): string {
  if (/auth|login|credential|401|403/i.test(message))
    return "Sign in to GitHub on this machine, then check that you can access the repository.";
  if (/404|not found|repository/i.test(message))
    return "Check the repository in Edit and your GitHub access on this machine.";
  if (/rate.?limit|429/i.test(message))
    return "GitHub is limiting requests. ace will try again at the next check.";
  return "Check your connection and GitHub access on this machine. ace will try again at the next check.";
}

export function PollError(props: { error: AutomationPollError }) {
  return (
    <div role="alert" className="mt-4 text-ui">
      <StatusLabel tone="failed" label="Couldn't check GitHub" />
      <p className="mt-1 text-sm text-muted-foreground">{fixHint(props.error.message)}</p>
    </div>
  );
}
