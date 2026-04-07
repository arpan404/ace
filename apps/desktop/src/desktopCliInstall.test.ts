import { describe, expect, it } from "vitest";

import {
  createDesktopCliInstallStateFromInspect,
  createDesktopCliInstallStateFromResult,
  createPendingDesktopCliInstallState,
  createUnsupportedDesktopCliInstallState,
} from "./desktopCliInstall";

describe("desktopCliInstall", () => {
  it("builds unsupported state with derived command metadata", () => {
    const state = createUnsupportedDesktopCliInstallState({
      baseDir: "/tmp/.ace",
      platform: "darwin",
      env: {
        SHELL: "/bin/zsh",
      },
      homeDir: "/tmp",
      shell: "/bin/zsh",
      checkedAt: "2026-04-07T00:00:00.000Z",
      message: "CLI install is only available in packaged desktop builds.",
    });

    expect(state).toEqual({
      status: "unsupported",
      binDir: "/tmp/.ace/bin",
      commandPath: "/tmp/.ace/bin/ace",
      pathTargets: ["/tmp/.zprofile", "/tmp/.zshrc"],
      checkedAt: "2026-04-07T00:00:00.000Z",
      restartRequired: false,
      message: "CLI install is only available in packaged desktop builds.",
    });
  });

  it("builds pending state with the expected path targets", () => {
    const state = createPendingDesktopCliInstallState({
      baseDir: "/tmp/.ace",
      platform: "linux",
      env: {
        SHELL: "/bin/bash",
      },
      homeDir: "/tmp",
      shell: "/bin/bash",
      status: "installing",
      message: "Installing the ace CLI.",
    });

    expect(state).toEqual({
      status: "installing",
      binDir: "/tmp/.ace/bin",
      commandPath: "/tmp/.ace/bin/ace",
      pathTargets: ["/tmp/.bash_profile", "/tmp/.bashrc"],
      checkedAt: null,
      restartRequired: false,
      message: "Installing the ace CLI.",
    });
  });

  it("maps a successful inspection to ready state", () => {
    const state = createDesktopCliInstallStateFromInspect(
      {
        binDir: "/tmp/.ace/bin",
        commandPath: "/tmp/.ace/bin/ace",
        pathTargets: ["/tmp/.zprofile"],
        ready: true,
      },
      {
        checkedAt: "2026-04-07T00:00:00.000Z",
      },
    );

    expect(state).toEqual({
      status: "ready",
      binDir: "/tmp/.ace/bin",
      commandPath: "/tmp/.ace/bin/ace",
      pathTargets: ["/tmp/.zprofile"],
      checkedAt: "2026-04-07T00:00:00.000Z",
      restartRequired: false,
      message: null,
    });
  });

  it("preserves restart guidance from an install result", () => {
    const state = createDesktopCliInstallStateFromResult(
      {
        binDir: "/tmp/.ace/bin",
        commandPath: "/tmp/.ace/bin/ace",
        shimInstalled: true,
        launchCommand: "/Applications/ace.app/Contents/MacOS/ace",
        launchCommandExists: true,
        cliEntry: "/Applications/ace.app/Contents/Resources/app/apps/server/dist/bin.mjs",
        cliEntryExists: true,
        pathInCurrentProcess: true,
        pathPersisted: true,
        pathTargets: ["/tmp/.zprofile"],
        shell: "/bin/zsh",
        ready: true,
        changed: true,
        pathChanged: true,
        restartRequired: true,
      },
      {
        checkedAt: "2026-04-07T00:00:00.000Z",
        message: "CLI installed. Open a new terminal window to use ace.",
      },
    );

    expect(state).toEqual({
      status: "ready",
      binDir: "/tmp/.ace/bin",
      commandPath: "/tmp/.ace/bin/ace",
      pathTargets: ["/tmp/.zprofile"],
      checkedAt: "2026-04-07T00:00:00.000Z",
      restartRequired: true,
      message: "CLI installed. Open a new terminal window to use ace.",
    });
  });
});
