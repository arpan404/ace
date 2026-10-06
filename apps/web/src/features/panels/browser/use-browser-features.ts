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
  error instanceof Error ? error.message : "The daemon refused it";

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
    if (!source.heldAs(threadId)) await source.takeover(threadId);
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
  return {
    features,
    origins,
    openTab: () =>
      attempt("Couldn't open a tab", async () => {
        await withControl();
        return features.openTab(threadId);
      }),
    switchTab: (tabId: string) =>
      attempt("Couldn't switch tabs", async () => {
        await withControl();
        return features.switchTab(threadId, tabId);
      }),
    closeTab: (tabId: string) =>
      attempt("Couldn't close the tab", async () => {
        await withControl();
        return features.closeTab(threadId, tabId);
      }),
    answerDialog: (tabId: string, dialogId: string, accept: boolean, promptText?: string) =>
      attempt("Couldn't answer the page", async () => {
        await withControl();
        return features.answerDialog(threadId, tabId, dialogId, accept, promptText);
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
