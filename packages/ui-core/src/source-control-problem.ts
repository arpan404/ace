import { providerMismatchMessage } from "@ace/protocol";

/**
 * The sentence for source control preferences that didn't parse. A provider that contradicts its
 * host says exactly that; every other problem gets the general one. Pure.
 */
export function preferencesProblem(error: { issues: readonly { message: string }[] }): string {
  return error.issues.some((issue) => issue.message === providerMismatchMessage)
    ? `${providerMismatchMessage}.`
    : "Enter a valid hostname, account and remote name.";
}
