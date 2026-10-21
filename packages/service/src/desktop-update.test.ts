import { expect, it } from "vitest";
import { desktopExecutable, newerDesktopRelease, type GithubRelease } from "./desktop-update.ts";

const release = (tag: string, extra: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: tag,
  draft: false,
  prerelease: tag.includes("-"),
  ...extra,
});

it("a stable install moves to the newest stable release and ignores previews and drafts", () => {
  const releases = [
    release("v1.3.0-preview.2"),
    release("v1.2.0"),
    release("v1.10.0", { draft: true }),
    release("v1.1.0"),
  ];
  expect(newerDesktopRelease(releases, "1.1.0")).toBe("1.2.0");
  expect(newerDesktopRelease(releases, "1.2.0")).toBeUndefined();
});

it("a preview install also sees newer previews", () => {
  const releases = [release("v1.3.0-preview.10"), release("v1.3.0-preview.2"), release("v1.2.0")];
  expect(newerDesktopRelease(releases, "1.3.0-preview.2")).toBe("1.3.0-preview.10");
});

it("the daemon's moving preview tag and malformed tags are not versions", () => {
  expect(
    newerDesktopRelease([release("preview"), release("2.0.0"), release("vnext")], "1.0.0"),
  ).toBeUndefined();
});

it("the app's executable sits beside its bundled daemon's resources on every platform", () => {
  expect(desktopExecutable("/Applications/ace.app/Contents/Resources/daemon", "darwin")).toBe(
    "/Applications/ace.app/Contents/MacOS/ace",
  );
  expect(desktopExecutable("/opt/ace/resources/daemon", "linux")).toBe("/opt/ace/ace");
  expect(desktopExecutable("C:\\Program Files\\ace\\resources\\daemon", "win32")).toBe(
    "C:\\Program Files\\ace\\ace.exe",
  );
});
