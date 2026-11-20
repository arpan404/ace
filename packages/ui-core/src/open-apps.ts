/**
 * The apps ace can open a file or folder in on the machine running it: editors and terminals,
 * one entry each, with how each platform finds it and how it is told what to open. The daemon
 * looks for these (only installed ones are offered) and builds the launch from the same entry,
 * so a launcher it reports is exactly one it agrees to run. The file manager is the platform's
 * own and is not listed here.
 */

export type OpenAppKind = "editor" | "terminal";

/** How an editor's launcher takes a position. */
export type PositionStyle = "goto" | "suffix" | "line-flag" | "none";

export interface OpenApp {
  id: string;
  name: string;
  kind: OpenAppKind;
  /** Launcher file names, preferred first: PATH names, then Linux package aliases. */
  commands: readonly string[];
  /** Editors: how a line is passed to `commands`; a bundle opened with `open -a` takes none. */
  position: PositionStyle;
  /**
   * Terminals: the arguments that start one in a folder, `{}` standing for the folder (alone or
   * after `=`). Each is its own argument; nothing goes through a shell.
   */
  folderArgs?: readonly string[];
  /**
   * macOS: the app bundles (first found wins) under an Applications folder, and the launcher
   * inside one when it has its own. Without a launcher the bundle opens with `open -a`.
   */
  mac?: { apps: readonly string[]; cli?: string; searchPath?: boolean };
  /**
   * Windows: the app's own `.exe`, found by its App Paths registration or in these install
   * folders (an environment variable, then path parts). Never a `.cmd` or `.bat` launcher.
   */
  windows?: { exe: string; installs: readonly (readonly string[])[] };
  /** Linux: whether `commands` are looked for there; true by default. */
  linux?: boolean;
}

const jetbrains = (
  id: string,
  name: string,
  apps: readonly string[],
  commands: readonly string[],
  exe: string,
): OpenApp => ({
  id,
  name,
  kind: "editor",
  commands,
  position: "line-flag",
  mac: { apps, cli: `Contents/MacOS/${commands[0] ?? id}`, searchPath: true },
  windows: { exe, installs: [] },
});

/** Editors and IDEs, in the order the menu lists them. */
const editors: readonly OpenApp[] = [
  {
    id: "code",
    name: "Visual Studio Code",
    kind: "editor",
    commands: ["code", "codium", "com.visualstudio.code", "com.vscodium.codium"],
    position: "goto",
    mac: {
      apps: ["Visual Studio Code.app"],
      cli: "Contents/Resources/app/bin/code",
      searchPath: true,
    },
    windows: {
      exe: "Code.exe",
      installs: [
        ["LOCALAPPDATA", "Programs", "Microsoft VS Code"],
        ["ProgramFiles", "Microsoft VS Code"],
      ],
    },
  },
  {
    id: "code-insiders",
    name: "VS Code Insiders",
    kind: "editor",
    commands: ["code-insiders", "com.visualstudio.code.insiders"],
    position: "goto",
    mac: {
      apps: ["Visual Studio Code - Insiders.app"],
      cli: "Contents/Resources/app/bin/code",
      searchPath: true,
    },
    windows: {
      exe: "Code - Insiders.exe",
      installs: [["LOCALAPPDATA", "Programs", "Microsoft VS Code Insiders"]],
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "editor",
    commands: ["cursor"],
    position: "goto",
    mac: { apps: ["Cursor.app"], cli: "Contents/Resources/app/bin/cursor", searchPath: true },
    windows: { exe: "Cursor.exe", installs: [["LOCALAPPDATA", "Programs", "cursor"]] },
  },
  {
    id: "windsurf",
    name: "Windsurf",
    kind: "editor",
    commands: ["windsurf"],
    position: "goto",
    mac: { apps: ["Windsurf.app"], cli: "Contents/Resources/app/bin/windsurf", searchPath: true },
    windows: { exe: "Windsurf.exe", installs: [["LOCALAPPDATA", "Programs", "Windsurf"]] },
  },
  {
    id: "zed",
    name: "Zed",
    kind: "editor",
    commands: ["zed", "zeditor", "dev.zed.Zed"],
    position: "suffix",
    mac: { apps: ["Zed.app"], cli: "Contents/MacOS/cli", searchPath: true },
    windows: { exe: "Zed.exe", installs: [["LOCALAPPDATA", "Programs", "Zed"]] },
  },
  {
    id: "subl",
    name: "Sublime Text",
    kind: "editor",
    commands: ["subl", "sublime-text.subl", "com.sublimetext.three"],
    position: "suffix",
    mac: { apps: ["Sublime Text.app"], cli: "Contents/SharedSupport/bin/subl", searchPath: true },
    windows: { exe: "sublime_text.exe", installs: [["ProgramFiles", "Sublime Text"]] },
  },
  {
    id: "nova",
    name: "Nova",
    kind: "editor",
    commands: [],
    position: "none",
    mac: { apps: ["Nova.app"] },
    linux: false,
  },
  {
    id: "bbedit",
    name: "BBEdit",
    kind: "editor",
    commands: [],
    position: "none",
    mac: { apps: ["BBEdit.app"] },
    linux: false,
  },
  {
    id: "xcode",
    name: "Xcode",
    kind: "editor",
    commands: [],
    position: "none",
    mac: { apps: ["Xcode.app"] },
    linux: false,
  },
  {
    id: "android-studio",
    name: "Android Studio",
    kind: "editor",
    commands: ["android-studio", "com.google.AndroidStudio"],
    position: "line-flag",
    mac: { apps: ["Android Studio.app"] },
    windows: {
      exe: "studio64.exe",
      installs: [["ProgramFiles", "Android", "Android Studio", "bin"]],
    },
  },
  {
    ...jetbrains(
      "idea",
      "IntelliJ IDEA",
      ["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app", "IntelliJ IDEA CE.app"],
      [
        "idea",
        "idea.sh",
        "intellij-idea-ultimate",
        "intellij-idea-community",
        "com.jetbrains.IntelliJ-IDEA-Ultimate",
        "com.jetbrains.IntelliJ-IDEA-Community",
      ],
      "idea64.exe",
    ),
  },
  jetbrains(
    "webstorm",
    "WebStorm",
    ["WebStorm.app"],
    ["webstorm", "webstorm.sh", "com.jetbrains.WebStorm"],
    "webstorm64.exe",
  ),
  jetbrains(
    "pycharm",
    "PyCharm",
    [
      "PyCharm.app",
      "PyCharm Professional Edition.app",
      "PyCharm CE.app",
      "PyCharm Community Edition.app",
    ],
    [
      "pycharm",
      "pycharm.sh",
      "pycharm-professional",
      "pycharm-community",
      "com.jetbrains.PyCharm-Professional",
      "com.jetbrains.PyCharm-Community",
    ],
    "pycharm64.exe",
  ),
  jetbrains(
    "goland",
    "GoLand",
    ["GoLand.app"],
    ["goland", "goland.sh", "com.jetbrains.GoLand"],
    "goland64.exe",
  ),
  jetbrains(
    "rustrover",
    "RustRover",
    ["RustRover.app"],
    ["rustrover", "rustrover.sh", "com.jetbrains.RustRover"],
    "rustrover64.exe",
  ),
  jetbrains(
    "clion",
    "CLion",
    ["CLion.app"],
    ["clion", "clion.sh", "com.jetbrains.CLion"],
    "clion64.exe",
  ),
  jetbrains(
    "phpstorm",
    "PhpStorm",
    ["PhpStorm.app"],
    ["phpstorm", "phpstorm.sh", "com.jetbrains.PhpStorm"],
    "phpstorm64.exe",
  ),
  jetbrains(
    "rider",
    "Rider",
    ["Rider.app"],
    ["rider", "rider.sh", "com.jetbrains.Rider"],
    "rider64.exe",
  ),
  {
    id: "fleet",
    name: "Fleet",
    kind: "editor",
    commands: ["fleet"],
    position: "none",
    mac: { apps: ["Fleet.app"] },
  },
];

/** Terminals, in the order the menu lists them. */
const terminals: readonly OpenApp[] = [
  {
    id: "terminal",
    name: "Terminal",
    kind: "terminal",
    commands: [],
    position: "none",
    mac: { apps: ["Terminal.app"] },
    linux: false,
  },
  {
    id: "iterm",
    name: "iTerm2",
    kind: "terminal",
    commands: [],
    position: "none",
    mac: { apps: ["iTerm.app"] },
    linux: false,
  },
  {
    id: "ghostty",
    name: "Ghostty",
    kind: "terminal",
    commands: ["ghostty", "com.mitchellh.ghostty"],
    position: "none",
    folderArgs: ["--working-directory={}"],
    // On macOS Ghostty's own binary doesn't open windows: the bundle opens the folder.
    mac: { apps: ["Ghostty.app"] },
  },
  {
    id: "warp",
    name: "Warp",
    kind: "terminal",
    commands: [],
    position: "none",
    mac: { apps: ["Warp.app"] },
    linux: false,
  },
  {
    id: "wezterm",
    name: "WezTerm",
    kind: "terminal",
    commands: ["wezterm", "org.wezfurlong.wezterm"],
    position: "none",
    folderArgs: ["start", "--cwd", "{}"],
    mac: { apps: ["WezTerm.app"], cli: "Contents/MacOS/wezterm" },
    windows: { exe: "wezterm-gui.exe", installs: [["ProgramFiles", "WezTerm"]] },
  },
  {
    id: "kitty",
    name: "Kitty",
    kind: "terminal",
    commands: ["kitty"],
    position: "none",
    folderArgs: ["--directory", "{}"],
    mac: { apps: ["kitty.app"], cli: "Contents/MacOS/kitty" },
  },
  {
    id: "alacritty",
    name: "Alacritty",
    kind: "terminal",
    commands: ["alacritty", "org.alacritty.Alacritty"],
    position: "none",
    folderArgs: ["--working-directory", "{}"],
    mac: { apps: ["Alacritty.app"], cli: "Contents/MacOS/alacritty" },
    windows: { exe: "alacritty.exe", installs: [["ProgramFiles", "Alacritty"]] },
  },
  {
    id: "windows-terminal",
    name: "Windows Terminal",
    kind: "terminal",
    commands: [],
    position: "none",
    folderArgs: ["-d", "{}"],
    windows: { exe: "wt.exe", installs: [["LOCALAPPDATA", "Microsoft", "WindowsApps"]] },
    linux: false,
  },
  {
    id: "ptyxis",
    name: "Ptyxis",
    kind: "terminal",
    commands: ["ptyxis", "app.devsuite.Ptyxis"],
    position: "none",
    folderArgs: ["--new-window", "--working-directory={}"],
  },
  {
    id: "gnome-terminal",
    name: "GNOME Terminal",
    kind: "terminal",
    commands: ["gnome-terminal"],
    position: "none",
    folderArgs: ["--working-directory={}"],
  },
  {
    id: "konsole",
    name: "Konsole",
    kind: "terminal",
    commands: ["konsole", "org.kde.konsole"],
    position: "none",
    folderArgs: ["--workdir", "{}"],
  },
];

/** Every app, editors first. */
export const openApps: readonly OpenApp[] = [...editors, ...terminals];

/** The app with `id`, if ace knows it. */
export function openApp(id: string): OpenApp | undefined {
  return openApps.find((app) => app.id === id);
}

/** What to open: a file at an optional position, or a folder. */
export interface OpenTarget {
  path: string;
  line?: number | undefined;
  column?: number | undefined;
}

/** A process to start: a launcher and its arguments, never a shell line. */
export interface AppLaunch {
  command: string;
  args: string[];
}

/** A macOS app bundle path, opened with `open -a` rather than run. */
export function isAppBundle(command: string): boolean {
  return /\.app\/?$/i.test(command);
}

/**
 * The launch that opens `target` in `app` through `command`, the launcher or bundle the daemon
 * found for it. A terminal is always handed a folder: the caller passes a file's folder, since a
 * terminal given a file may run it. Undefined for a terminal with no way to name a folder.
 */
export function appLaunch(
  app: OpenApp,
  command: string,
  target: OpenTarget,
): AppLaunch | undefined {
  const { path, line, column } = target;
  if (isAppBundle(command)) return { command: "/usr/bin/open", args: ["-a", command, path] };
  if (app.kind === "terminal") {
    if (!app.folderArgs) return undefined;
    return {
      command,
      args: app.folderArgs.map((arg) =>
        arg === "{}" ? path : arg.endsWith("={}") ? `${arg.slice(0, -2)}${path}` : arg,
      ),
    };
  }
  if (!line) return { command, args: [path] };
  const at = `${path}:${line}${column ? `:${column}` : ""}`;
  switch (app.position) {
    case "goto":
      return { command, args: ["-g", at] };
    case "suffix":
      return { command, args: [at] };
    case "line-flag":
      return {
        command,
        args: ["--line", String(line), ...(column ? ["--column", String(column)] : []), path],
      };
    case "none":
      return { command, args: [path] };
  }
}
