import { BrowserActionError } from "./action-error.ts";
import type { BrowserBackendTabs } from "./backend.ts";

/**
 * What only the person asks of a page: answering a site's sign-in prompt, proceeding past a
 * certificate warning or turning a tab's sound on. These arrive from a person's client connection only; no agent tool sends
 * them, so an agent never types a site password or bypasses a certificate.
 */
export type PersonRequest =
  | {
      kind: "auth";
      tabId: string;
      authId: string;
      credentials?: { username: string; password: string } | undefined;
    }
  | { kind: "certificate"; tabId: string; url: string }
  | { kind: "mute"; tabId: string; muted: boolean };

export async function requestAsPerson(
  tabs: BrowserBackendTabs | undefined,
  answer: PersonRequest,
): Promise<void> {
  switch (answer.kind) {
    case "auth":
      if (!tabs?.answerAuth) throw new BrowserActionError("not_supported");
      await tabs.answerAuth(answer.tabId, answer.authId, answer.credentials);
      return;
    case "certificate":
      if (!tabs?.proceedCertificate) throw new BrowserActionError("not_supported");
      await tabs.proceedCertificate(answer.tabId, answer.url);
      return;
    case "mute":
      if (!tabs?.mute) throw new BrowserActionError("not_supported");
      await tabs.mute(answer.tabId, answer.muted);
      return;
  }
}
