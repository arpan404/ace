import { BrowserFeaturesClient } from "@ace/client";
import { BrowserArtifact, ThreadId } from "@ace/protocol";
import { useClient } from "@ace/client-react";
import { useToast } from "@/components/ui/toast.tsx";
import { LocalStore } from "../store.ts";
import { askContext, uploadContextFile } from "@/lib/context-requests.ts";

/** Threads whose page this window started recording (the daemon has no "is recording" read). */
export const recordingThreads = new LocalStore<ReadonlySet<string>>(new Set());

/** A daemon refusal as a sentence for a toast. */
export const reason = (error: unknown) =>
  error instanceof Error ? error.message : "ace refused it";

/**
 * The browser's parity controls for one thread: dialogs and recording. Each is a one-shot
 * request, never replayed after a reconnect. The person needs no control to use them.
 */
export function useBrowserFeatures(threadId: string) {
  const client = useClient();
  const toast = useToast();
  const features = new BrowserFeaturesClient(client);
  const attempt = async <T>(title: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      toast.error({ title, description: reason(error) });
      return undefined;
    }
  };
  const recording = async (type: "browser.recording.start" | "browser.recording.stop") => {
    const reply = await client.request({ type, threadId: ThreadId.parse(threadId) });
    if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
    return reply.result;
  };
  const answerDialog = async (
    tabId: string,
    dialogId: string,
    accept: boolean,
    promptText?: string,
  ) => features.answerDialog(threadId, tabId, dialogId, accept, promptText);
  return {
    features,
    answerDialog: (tabId: string, dialogId: string, accept: boolean, promptText?: string) =>
      attempt("Couldn't answer the page", () => answerDialog(tabId, dialogId, accept, promptText)),

    answerAuth: (tabId: string, authId: string, credentials?: SignInAnswer) =>
      attempt("Couldn't answer the sign-in", () =>
        features.answerAuth(threadId, tabId, authId, credentials),
      ),
    /**
     * The person's files for a page's file picker: uploaded as thread attachments, set on the
     * page's input by the daemon, then let go of (the browser keeps its own copy).
     */
    chooseFiles: (tabId: string, chooserId: string, files: readonly File[]) =>
      attempt("Couldn't give the page your files", async () => {
        const uploaded = [];
        for (const file of files)
          uploaded.push(await uploadContextFile(client, { threadId }, file, () => {}));
        try {
          return await features.chooseFiles(
            threadId,
            tabId,
            chooserId,
            uploaded.map((attachment) => ({
              sha256: attachment.sha256,
              name: attachment.name || "file",
            })),
          );
        } finally {
          const ask = askContext(client);
          for (const attachment of uploaded)
            void ask({
              op: "attachment.release",
              threadId: ThreadId.parse(threadId),
              sha256: attachment.sha256,
            }).catch(() => {});
        }
      }),
    muteTab: (tabId: string, muted: boolean) =>
      attempt(muted ? "Couldn't mute the tab" : "Couldn't unmute the tab", () =>
        features.muteTab(threadId, tabId, muted),
      ),
    proceedCertificate: (tabId: string, url: string) =>
      attempt("Couldn't open the page", () => features.proceedCertificate(threadId, tabId, url)),
    startRecording: () =>
      attempt("Couldn't start recording", async () => {
        await recording("browser.recording.start");
        return true;
      }),
    stopRecording: () =>
      attempt("Couldn't stop recording", async () => {
        const artifact = BrowserArtifact.safeParse(await recording("browser.recording.stop"));
        return artifact.success ? artifact.data : undefined;
      }),
  };
}

export type BrowserFeatures = ReturnType<typeof useBrowserFeatures>;
export interface SignInAnswer {
  username: string;
  password: string;
}
