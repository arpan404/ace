import { ProjectId, ThreadId } from "@ace/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  queueBrowserLaunchRequest,
  requestInAppBrowserFromShell,
  takePendingBrowserLaunchRequest,
} from "./launcher";

const PROJECT_ID = ProjectId.makeUnsafe("project-browser-launcher");
const ROUTE_THREAD_ID = ThreadId.makeUnsafe("thread-browser-launcher-route");
const FALLBACK_THREAD_ID = ThreadId.makeUnsafe("thread-browser-launcher-fallback");

describe("browser launcher", () => {
  afterEach(() => {
    takePendingBrowserLaunchRequest();
    vi.clearAllMocks();
  });

  it("queues and consumes browser launch requests", () => {
    queueBrowserLaunchRequest({ action: "open", url: "https://example.com" });

    expect(takePendingBrowserLaunchRequest()).toEqual({
      action: "open",
      url: "https://example.com",
    });
    expect(takePendingBrowserLaunchRequest()).toBeNull();
  });

  it("keeps the request pending when the current route already hosts the browser", async () => {
    const handleNewThread = vi.fn(async () => undefined);
    const navigateToThread = vi.fn(async () => undefined);

    const launched = await requestInAppBrowserFromShell({
      routeThreadId: ROUTE_THREAD_ID,
      fallbackThreadId: null,
      activeProjectId: PROJECT_ID,
      activeThread: null,
      activeDraftThread: null,
      defaultProjectId: PROJECT_ID,
      defaultThreadEnvMode: "local",
      handleNewThread,
      navigateToThread,
      request: { action: "open" },
    });

    expect(launched).toBe(true);
    expect(handleNewThread).not.toHaveBeenCalled();
    expect(navigateToThread).not.toHaveBeenCalled();
    expect(takePendingBrowserLaunchRequest()).toEqual({ action: "open" });
  });

  it("navigates back to the last active thread before creating a new one", async () => {
    const handleNewThread = vi.fn(async () => undefined);
    const navigateToThread = vi.fn(async () => undefined);

    const launched = await requestInAppBrowserFromShell({
      routeThreadId: null,
      fallbackThreadId: FALLBACK_THREAD_ID,
      activeProjectId: PROJECT_ID,
      activeThread: null,
      activeDraftThread: null,
      defaultProjectId: PROJECT_ID,
      defaultThreadEnvMode: "local",
      handleNewThread,
      navigateToThread,
      request: { action: "open" },
    });

    expect(launched).toBe(true);
    expect(navigateToThread).toHaveBeenCalledWith(FALLBACK_THREAD_ID);
    expect(handleNewThread).not.toHaveBeenCalled();
    expect(takePendingBrowserLaunchRequest()).toEqual({ action: "open" });
  });

  it("creates a thread when the shell needs a browser host route", async () => {
    const handleNewThread = vi.fn(async () => undefined);
    const navigateToThread = vi.fn(async () => undefined);

    const launched = await requestInAppBrowserFromShell({
      routeThreadId: null,
      fallbackThreadId: null,
      activeProjectId: PROJECT_ID,
      activeThread: null,
      activeDraftThread: null,
      defaultProjectId: PROJECT_ID,
      defaultThreadEnvMode: "local",
      handleNewThread,
      navigateToThread,
      request: { action: "open" },
    });

    expect(launched).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(PROJECT_ID, { envMode: "local" });
    expect(navigateToThread).not.toHaveBeenCalled();
    expect(takePendingBrowserLaunchRequest()).toEqual({ action: "open" });
  });

  it("clears pending browser launches when no project is available", async () => {
    const handleNewThread = vi.fn(async () => undefined);
    const navigateToThread = vi.fn(async () => undefined);
    const onMissingProject = vi.fn();

    const launched = await requestInAppBrowserFromShell({
      routeThreadId: null,
      fallbackThreadId: null,
      activeProjectId: null,
      activeThread: null,
      activeDraftThread: null,
      defaultProjectId: null,
      defaultThreadEnvMode: "local",
      handleNewThread,
      navigateToThread,
      request: { action: "open" },
      onMissingProject,
    });

    expect(launched).toBe(false);
    expect(handleNewThread).not.toHaveBeenCalled();
    expect(navigateToThread).not.toHaveBeenCalled();
    expect(onMissingProject).toHaveBeenCalledTimes(1);
    expect(takePendingBrowserLaunchRequest()).toBeNull();
  });
});
