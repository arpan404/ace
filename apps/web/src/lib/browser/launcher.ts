import type { ProjectId, ThreadId } from "@ace/contracts";

import type { DraftThreadEnvMode } from "~/composerDraftStore";
import { resolveSidebarNewThreadOptions } from "~/lib/sidebar";

export interface BrowserLaunchRequest {
  readonly action?: "open";
  readonly newTab?: boolean;
  readonly url?: string;
}

type HandleNewThread = (
  projectId: ProjectId,
  options?: {
    branch?: string | null;
    worktreePath?: string | null;
    envMode?: DraftThreadEnvMode;
  },
) => Promise<void>;

interface BrowserThreadSeed {
  readonly branch: string | null;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

interface BrowserDraftThreadSeed extends BrowserThreadSeed {
  readonly envMode: DraftThreadEnvMode;
}

interface RequestInAppBrowserFromShellInput {
  readonly routeThreadId: ThreadId | null;
  readonly fallbackThreadId: ThreadId | null;
  readonly activeProjectId: ProjectId | null;
  readonly activeThread: BrowserThreadSeed | null;
  readonly activeDraftThread: BrowserDraftThreadSeed | null;
  readonly defaultProjectId: ProjectId | null;
  readonly defaultThreadEnvMode: DraftThreadEnvMode;
  readonly handleNewThread: HandleNewThread;
  readonly navigateToThread: (threadId: ThreadId) => Promise<void>;
  readonly request: BrowserLaunchRequest;
  readonly onMissingProject?: () => void;
}

const BROWSER_LAUNCH_REQUEST_EVENT = "ace:browser-launch-request";

let pendingBrowserLaunchRequest: BrowserLaunchRequest | null = null;

function clearPendingBrowserLaunchRequest(): void {
  pendingBrowserLaunchRequest = null;
}

export function queueBrowserLaunchRequest(request: BrowserLaunchRequest): void {
  pendingBrowserLaunchRequest = {
    action: "open",
    ...request,
  };

  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event(BROWSER_LAUNCH_REQUEST_EVENT));
}

export function takePendingBrowserLaunchRequest(): BrowserLaunchRequest | null {
  const request = pendingBrowserLaunchRequest;
  clearPendingBrowserLaunchRequest();
  return request;
}

export function subscribeToBrowserLaunchRequests(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleRequest = () => {
    listener();
  };

  window.addEventListener(BROWSER_LAUNCH_REQUEST_EVENT, handleRequest);
  return () => {
    window.removeEventListener(BROWSER_LAUNCH_REQUEST_EVENT, handleRequest);
  };
}

export async function requestInAppBrowserFromShell(
  input: RequestInAppBrowserFromShellInput,
): Promise<boolean> {
  queueBrowserLaunchRequest(input.request);

  if (input.routeThreadId) {
    return true;
  }

  if (input.fallbackThreadId) {
    await input.navigateToThread(input.fallbackThreadId);
    return true;
  }

  const projectId = input.activeProjectId ?? input.defaultProjectId;
  if (!projectId) {
    clearPendingBrowserLaunchRequest();
    input.onMissingProject?.();
    return false;
  }

  await input.handleNewThread(
    projectId,
    resolveSidebarNewThreadOptions({
      projectId,
      defaultEnvMode: input.defaultThreadEnvMode,
      activeThread: input.activeThread,
      activeDraftThread: input.activeDraftThread,
    }),
  );
  return true;
}
