import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startMock = vi.fn<() => Promise<void>>();
const getStatusMock = vi.fn();
const getAuthStatusMock = vi.fn();
const listModelsMock = vi.fn();
const stopMock = vi.fn<() => Promise<ReadonlyArray<Error>>>();
const forceStopMock = vi.fn<() => Promise<void>>();

vi.mock("@github/copilot-sdk", () => {
  class MockCopilotClient {
    start = startMock;
    getStatus = getStatusMock;
    getAuthStatus = getAuthStatusMock;
    listModels = listModelsMock;
    createSession = vi.fn();
    resumeSession = vi.fn();
    stop = stopMock;
    forceStop = forceStopMock;
  }

  return {
    CopilotClient: MockCopilotClient,
    default: {
      CopilotClient: MockCopilotClient,
    },
  };
});

import { createGitHubCopilotClient, probeGitHubCopilotSdk } from "./githubCopilotSdk";

const TEST_MODEL = {
  id: "gpt-5",
  name: "GPT-5",
  capabilities: {
    supports: {
      vision: false,
      reasoningEffort: true,
    },
    limits: {
      max_context_window_tokens: 200_000,
    },
  },
  supportedReasoningEfforts: ["medium"],
  defaultReasoningEffort: "medium",
};

describe("githubCopilotSdk", () => {
  beforeEach(() => {
    startMock.mockReset();
    getStatusMock.mockReset();
    getAuthStatusMock.mockReset();
    listModelsMock.mockReset();
    stopMock.mockReset();
    forceStopMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("force stops the client when startup hangs", async () => {
    vi.useFakeTimers();
    startMock.mockReturnValue(new Promise(() => undefined));
    stopMock.mockReturnValue(new Promise(() => undefined));
    forceStopMock.mockResolvedValue(undefined);

    const startup = createGitHubCopilotClient("/bin/copilot", {
      startupTimeoutMs: 10,
      stopTimeoutMs: 10,
    });
    const startupResult = expect(startup).rejects.toThrow(
      /Timed out starting GitHub Copilot client after 10ms/,
    );

    await vi.advanceTimersByTimeAsync(25);

    await startupResult;
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(forceStopMock).toHaveBeenCalledTimes(1);
  });

  it("times out slow probe requests and still stops the client", async () => {
    vi.useFakeTimers();
    startMock.mockResolvedValue(undefined);
    getStatusMock.mockResolvedValue({ version: "1.2.3", protocolVersion: 1 });
    getAuthStatusMock.mockReturnValue(new Promise(() => undefined));
    listModelsMock.mockResolvedValue([TEST_MODEL]);
    stopMock.mockResolvedValue([]);
    forceStopMock.mockResolvedValue(undefined);

    const probe = probeGitHubCopilotSdk("/bin/copilot", {
      requestTimeoutMs: 10,
      stopTimeoutMs: 10,
    });

    await vi.advanceTimersByTimeAsync(15);

    await expect(probe).resolves.toMatchObject({
      version: "1.2.3",
      auth: null,
      models: [
        {
          slug: "gpt-5",
          name: "GPT-5",
        },
      ],
      issues: ["Timed out fetching GitHub Copilot auth status after 10ms."],
    });
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(forceStopMock).not.toHaveBeenCalled();
  });
});
