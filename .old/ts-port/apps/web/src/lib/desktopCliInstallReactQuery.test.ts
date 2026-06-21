import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { DesktopCliInstallState } from "@ace/contracts";

import {
  desktopCliInstallQueryKeys,
  desktopCliInstallStateQueryOptions,
  setDesktopCliInstallStateQueryData,
} from "./desktopCliInstallReactQuery";

const baseState: DesktopCliInstallState = {
  status: "ready",
  binDir: "/tmp/.ace/bin",
  commandPath: "/tmp/.ace/bin/ace",
  pathTargets: ["/tmp/.zprofile"],
  checkedAt: "2026-04-07T00:00:00.000Z",
  progressPercent: null,
  restartRequired: false,
  message: "The `ace` command is already ready to use.",
};

describe("desktopCliInstallStateQueryOptions", () => {
  it("always refetches on mount so Settings does not reuse stale CLI install state", () => {
    const options = desktopCliInstallStateQueryOptions();

    expect(options.staleTime).toBe(Infinity);
    expect(options.refetchOnMount).toBe("always");
  });
});

describe("setDesktopCliInstallStateQueryData", () => {
  it("writes desktop CLI install state into the shared cache key", () => {
    const queryClient = new QueryClient();
    const nextState: DesktopCliInstallState = {
      ...baseState,
      status: "installing",
      message: "Installing the `ace` CLI.",
    };

    setDesktopCliInstallStateQueryData(queryClient, nextState);

    expect(queryClient.getQueryData(desktopCliInstallQueryKeys.state())).toEqual(nextState);
  });
});
