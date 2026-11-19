import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { appIcon } from "./app-icon.ts";
import { installedIconPng, rasterPng } from "./icon-image.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A home and a system data dir holding the given files. */
async function desktop(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "ace-icons-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return {
    root,
    env: { HOME: join(root, "home"), XDG_DATA_DIRS: join(root, "usr/share") },
  };
}

const lookup = (identity: string, env: NodeJS.ProcessEnv) =>
  appIcon(identity, { platform: "linux", env, run: () => Promise.reject(new Error("no runs")) });
const entry = (icon: string) =>
  `[Desktop Entry]\nName=App\nIcon=${icon}\n\n[Desktop Action new]\nIcon=other\n`;

it("an app's icon is the largest hicolor PNG its desktop entry names", async () => {
  const { env } = await desktop({
    "usr/share/applications/org.example.Writer.desktop": entry("writer"),
    "usr/share/icons/hicolor/48x48/apps/writer.png": "small",
    "usr/share/icons/hicolor/256x256/apps/writer.png": "large",
    "usr/share/icons/hicolor/scalable/apps/writer.svg": "<svg/>",
  });
  expect((await lookup("org.example.Writer", env))?.toString()).toBe("large");
});

it("an app with only a scalable icon gets its SVG, and one in pixmaps is found there", async () => {
  const { env } = await desktop({
    "usr/share/applications/org.gnome.Calculator.desktop": entry("org.gnome.Calculator"),
    "usr/share/icons/hicolor/scalable/apps/org.gnome.Calculator.svg": "<svg>calc</svg>",
    "usr/share/applications/code.desktop": entry("vscode"),
    "usr/share/pixmaps/vscode.png": "code",
  });
  expect((await lookup("org.gnome.Calculator", env))?.toString()).toBe("<svg>calc</svg>");
  expect((await lookup("code", env))?.toString()).toBe("code");
});

it("the person's own desktop entry wins over the system's", async () => {
  const { env } = await desktop({
    "home/.local/share/applications/app.desktop": entry("mine"),
    "usr/share/applications/app.desktop": entry("system"),
    "home/.local/share/icons/hicolor/64x64/apps/mine.png": "mine",
    "usr/share/icons/hicolor/64x64/apps/system.png": "system",
  });
  expect((await lookup("app", env))?.toString()).toBe("mine");
});

it("an unknown app, an entry with no icon, or an icon path that isn't a file gives no icon", async () => {
  const { root, env } = await desktop({
    "usr/share/applications/bare.desktop": "[Desktop Entry]\nName=Bare\n",
    "usr/share/applications/folder.desktop": entry("/"),
  });
  await mkdir(join(root, "usr/share/icons"), { recursive: true });
  expect(await lookup("missing", env)).toBeNull();
  expect(await lookup("bare", env)).toBeNull();
  expect(await lookup("folder", env)).toBeNull();
  // An id is a name, never a path out of the applications folder.
  expect(await lookup("../../etc/passwd", env)).toBeNull();
});

it("a KDE app's icon comes from its Breeze theme, and a theme's odd sizes count", async () => {
  const { env } = await desktop({
    "usr/share/applications/org.kde.kcalc.desktop": entry("accessories-calculator"),
    "usr/share/icons/breeze/apps/48/accessories-calculator.svg": "<svg>breeze</svg>",
    "usr/share/icons/breeze/apps/48@2x/accessories-calculator.svg": "<svg>big</svg>",
    "usr/share/applications/org.kde.kate.desktop": entry("kate"),
    "usr/share/icons/hicolor/310x310/apps/kate.png": "kate 310",
    "usr/share/icons/breeze/apps/48/kate.svg": "<svg>kate</svg>",
  });
  expect((await lookup("org.kde.kcalc", env))?.toString()).toBe("<svg>big</svg>");
  // The app's own hicolor icon wins over the theme's.
  expect((await lookup("org.kde.kate", env))?.toString()).toBe("kate 310");
});

it("an installed SVG icon with inline styles is drawn, one with a script never is", async () => {
  const styled = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" style="fill:#3584e4"/></svg>',
  );
  const scripted = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>',
  );
  const png = await installedIconPng(styled);
  expect(png?.subarray(1, 4).toString()).toBe("PNG");
  expect(await installedIconPng(scripted)).toBeNull();
  // A downloaded or repository SVG with the same inline style is still refused.
  expect(await rasterPng(styled, true)).toBeNull();
});
