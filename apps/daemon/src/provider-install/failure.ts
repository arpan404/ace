import type { ProviderInstallPlan } from "@ace/protocol";

export const genericInstallFailure = "Installer failed. Review the sanitized log and retry.";

/** curl's own wording for its common network failures, keyed by exit code. */
const curlReasons: Readonly<Record<number, string>> = {
  6: "the server name could not be resolved",
  7: "the server could not be reached",
  28: "the download timed out",
  35: "the secure connection failed",
  60: "the server's certificate was not trusted",
};
const curlError = /^curl: \((\d+)\)\s*(.*)$/;
const httpStatus = /returned error:?\s*(\d{3})\b/i;

function downloadProblem(line: string): string | undefined {
  const match = curlError.exec(line.trim());
  if (!match) return undefined;
  const status = httpStatus.exec(match[2] ?? "")?.[1];
  if (status) return `HTTP ${status}`;
  return curlReasons[Number(match[1])] ?? `curl error ${match[1]}`;
}

/**
 * Words for a failed installer command. `output` is that command's own output in order.
 * A piped script install whose first output is a curl error never received the script; a
 * later curl error came from the script's own downloads. Anything else stays generic.
 */
export function installFailureMessage(
  plan: Pick<ProviderInstallPlan, "action" | "method" | "installedVersion">,
  output: readonly string[],
): string {
  if (plan.method !== "script" || plan.action === "uninstall") return genericInstallFailure;
  const first = output.find((line) => line.trim() !== "");
  const fetch = first === undefined ? undefined : downloadProblem(first);
  const later = fetch ? undefined : output.map(downloadProblem).find(Boolean);
  if (!fetch && !later) return genericInstallFailure;
  const what = fetch
    ? `Couldn't download the official installer (${fetch}).`
    : `The official installer couldn't download its files (${later}).`;
  const kept =
    plan.action === "update" && plan.installedVersion
      ? ` Version ${plan.installedVersion} is still installed.`
      : "";
  return `${what}${kept} The download server may be unavailable; try again later.`;
}
