import { BrowserFeaturesClient, BrowserOriginsClient } from "@ace/client";
import { BrowserArtifact, ThreadId } from "@ace/protocol";
import { useClient } from "@ace/client-react";
import { useToast } from "@/components/ui/toast.tsx";
import type { PreviewSource } from "../sources.ts";
import { LocalStore } from "../store.ts";

/** Threads whose page this window started recording (the daemon has no "is recording" read). */
export const recordingThreads = new LocalStore<ReadonlySet<string>>(new Set());

/** A daemon refusal as a sentence for a toast. */
export const reason = (error: unknown) =>
  error instanceof Error ? error.message : "ace refused it";

/**
 * The browser's parity controls for one thread: its agent tabs, dialogs, downloads, site grants,
 * private takeover and recording. Each is a one-shot request, never replayed after a reconnect.
 * Tab changes and dialog answers need the person's control lease, so they take it first.
 */
export function useBrowserFeatures(source: PreviewSource, threadId: string) {
  const client = useClient();
  const toast = useToast();
  const features = new BrowserFeaturesClient(client);
  const origins = new BrowserOriginsClient(client);
  const withControl = async () => {
    if (source.heldAs(threadId)) return false;
    await source.takeover(threadId);
    return true;
  };
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
  ) => {
    await withControl();
    return features.answerDialog(threadId, tabId, dialogId, accept, promptText);
  };
  const returnControl = async () => {
    try {
      await source.handback(threadId);
    } catch (error) {
      const id = toast.error({
        title: "Couldn't hand back the page",
        description: reason(error),
        timeout: 0,
        actionProps: {
          children: "Hand back",
          onClick: async () => {
            try {
              await source.handback(threadId);
              toast.close(id);
            } catch (retryError) {
              toast.update(id, { description: reason(retryError) });
            }
          },
        },
      });
    }
  };
  return {
    features,
    origins,
    answerDialog: (tabId: string, dialogId: string, accept: boolean, promptText?: string) =>
      attempt("Couldn't answer the page", () => answerDialog(tabId, dialogId, accept, promptText)),
    answerBackgroundDialog: (
      retainControl: () => boolean,
      tabId: string,
      dialogId: string,
      accept: boolean,
      promptText?: string,
    ) =>
      attempt("Couldn't answer the page", async () => {
        let acquired = false;
        try {
          acquired = await withControl();
          return await features.answerDialog(threadId, tabId, dialogId, accept, promptText);
        } finally {
          if (acquired && !retainControl() && source.view(threadId)?.takeoverMode !== "private")
            await returnControl();
        }
      }),
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
