import { describe, expect, it } from "vitest";

import {
  DESKTOP_UPDATE_ARG,
  hasDesktopUpdateArg,
  resolveDesktopSecondInstanceAction,
} from "./desktopUpdateLaunch";

describe("desktopUpdateLaunch", () => {
  it("detects packaged headless update launches", () => {
    expect(
      hasDesktopUpdateArg(["/Applications/ace.app/Contents/MacOS/ace", DESKTOP_UPDATE_ARG], true),
    ).toBe(true);
  });

  it("ignores update launches outside packaged builds", () => {
    expect(hasDesktopUpdateArg(["electron", DESKTOP_UPDATE_ARG], false)).toBe(false);
  });

  it("routes second update instances to the running app updater", () => {
    expect(resolveDesktopSecondInstanceAction(["ace", DESKTOP_UPDATE_ARG], true)).toBe(
      "run-update",
    );
    expect(resolveDesktopSecondInstanceAction(["ace"], true)).toBe("focus");
  });
});
