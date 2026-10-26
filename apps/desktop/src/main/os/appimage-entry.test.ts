import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { installAppImageEntry, nodeAppImageEntryFiles } from "./appimage-entry.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A home, the AppImage's mount with its icon, and the system's (empty) shared data dir. */
function machine() {
  const root = mkdtempSync(join(tmpdir(), "ace-appimage-entry-"));
  roots.push(root);
  const mount = join(root, "mount");
  const shared = join(root, "usr-share");
  mkdirSync(mount);
  mkdirSync(shared);
  writeFileSync(join(mount, ".DirIcon"), "png bytes");
  const home = join(root, "home");
  const entry = join(home, ".local/share/applications/dev.ace.app.desktop");
  return { root, mount, shared, home, entry };
}

function install(
  where: ReturnType<typeof machine>,
  env: Record<string, string | undefined>,
  execPath = join(where.mount, "ace-desktop"),
): string[] {
  const warnings: string[] = [];
  installAppImageEntry({
    env: { XDG_DATA_DIRS: where.shared, APPDIR: where.mount, ...env },
    home: where.home,
    execPath,
    files: nodeAppImageEntryFiles,
    warn: (message) => warnings.push(message),
  });
  return warnings;
}

const line = (path: string, key: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(`${key}=`));

test("an app run from an AppImage adds itself to the app list, opening links with the image file", () => {
  const where = machine();
  expect(install(where, { APPIMAGE: "/home/me/Apps/ace 1.0.AppImage" })).toEqual([]);
  expect(line(where.entry, "Exec")).toBe('Exec="/home/me/Apps/ace 1.0.AppImage" %U');
  expect(line(where.entry, "MimeType")).toBe("MimeType=x-scheme-handler/ace;inode/directory;");
  // The window's Wayland app id, so the desktop ties the window to this entry.
  expect(line(where.entry, "StartupWMClass")).toBe("StartupWMClass=dev.ace.app");
  expect(line(where.entry, "Icon")).toBe("Icon=ace-desktop");
  expect(
    readFileSync(
      join(where.home, ".local/share/icons/hicolor/512x512/apps/ace-desktop.png"),
      "utf8",
    ),
  ).toBe("png bytes");
});

test("a moved AppImage points the entry at its new place", () => {
  const where = machine();
  install(where, { APPIMAGE: "/home/me/Downloads/ace.AppImage" });
  install(where, { APPIMAGE: "/home/me/Apps/ace.AppImage" });
  expect(line(where.entry, "Exec")).toBe("Exec=/home/me/Apps/ace.AppImage %U");
});

test("the entry follows XDG_DATA_HOME", () => {
  const where = machine();
  const data = join(where.root, "data");
  install(where, { APPIMAGE: "/opt/ace.AppImage", XDG_DATA_HOME: data });
  expect(existsSync(join(data, "applications/dev.ace.app.desktop"))).toBe(true);
  expect(existsSync(where.entry)).toBe(false);
});

test("an entry a package installed is left to the package, and a non-AppImage run writes nothing", () => {
  const packaged = machine();
  mkdirSync(join(packaged.shared, "applications"));
  writeFileSync(join(packaged.shared, "applications/dev.ace.app.desktop"), "[Desktop Entry]\n");
  install(packaged, { APPIMAGE: "/opt/ace.AppImage" });
  expect(existsSync(packaged.entry)).toBe(false);

  const unpacked = machine();
  install(
    unpacked,
    { APPIMAGE: undefined },
    "/home/me/code/ace/node_modules/electron/dist/electron",
  );
  expect(existsSync(unpacked.entry)).toBe(false);
});

test("without the image's icon the entry still names the app, with no icon line", () => {
  const where = machine();
  rmSync(join(where.mount, ".DirIcon"));
  install(where, { APPIMAGE: "/opt/ace.AppImage" });
  expect(line(where.entry, "Name")).toBe("Name=ace");
  expect(line(where.entry, "Icon")).toBeUndefined();
});

test("an extracted tar.gz adds itself too, opening links with its launcher and showing its icon", () => {
  const where = machine();
  const folder = join(where.root, "ace-1.0.0-arm64");
  mkdirSync(folder);
  writeFileSync(join(folder, "ace-desktop.png"), "tar icon");
  install(where, { APPIMAGE: undefined, APPDIR: undefined }, join(folder, "ace-desktop-bin"));
  expect(line(where.entry, "Exec")).toBe(`Exec=${join(folder, "ace-desktop")} %U`);
  expect(line(where.entry, "Icon")).toBe("Icon=ace-desktop");
  expect(
    readFileSync(
      join(where.home, ".local/share/icons/hicolor/512x512/apps/ace-desktop.png"),
      "utf8",
    ),
  ).toBe("tar icon");
});

test("the ace-desktop entry an earlier AppImage wrote is replaced, so ace is listed once", () => {
  const where = machine();
  const applications = join(where.home, ".local/share/applications");
  mkdirSync(applications, { recursive: true });
  const old = join(applications, "ace-desktop.desktop");
  writeFileSync(
    old,
    "[Desktop Entry]\nType=Application\nName=ace\nComment=Local multi-agent coding environment\nExec=/opt/ace.AppImage %U\nStartupWMClass=ace-desktop\n",
  );
  install(where, { APPIMAGE: "/opt/ace.AppImage" });
  expect(existsSync(old)).toBe(false);
  expect(existsSync(where.entry)).toBe(true);

  // One the person edited is theirs now, and stays.
  const edited = machine();
  const editedOld = join(edited.home, ".local/share/applications/ace-desktop.desktop");
  mkdirSync(dirname(editedOld), { recursive: true });
  writeFileSync(editedOld, "[Desktop Entry]\nName=ace, my way\nExec=/opt/ace.AppImage\n");
  install(edited, { APPIMAGE: "/opt/ace.AppImage" });
  expect(existsSync(editedOld)).toBe(true);
});

test("the deb's launch removes the entry an AppImage wrote, which would hide the package's", () => {
  const where = machine();
  install(where, { APPIMAGE: "/opt/ace.AppImage" });
  expect(existsSync(where.entry)).toBe(true);
  install(where, { APPIMAGE: undefined, APPDIR: undefined }, "/opt/ace/ace-desktop");
  expect(existsSync(where.entry)).toBe(false);
});
