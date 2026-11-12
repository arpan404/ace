import type { Toolchain } from "@ace/protocol";

/*
 * Settings › Simulators, shared by the web and the phone: the words of the switch that turns a
 * machine's simulators and emulators on or off (and what it asks before turning them off), and
 * each tool they need as a row: its name, Ready or Not installed, and how to get it. Pure.
 */

export const devicesSwitch = {
  title: "Use simulators and emulators",
  description:
    "Watch and drive this machine's iOS Simulators and Android emulators from any thread, and let agents use them.",
  /** Turning devices off ends what agents and live views are doing on them, so it asks first. */
  askOff: {
    title: "Turn off simulators and emulators?",
    message:
      "This turns them off for every thread on this machine. Agents lose the devices they are using, and live views stop. They stay off until you turn them on here.",
    confirm: "Turn off",
  },
} as const;

/** Show emulator window (`devices.emulatorWindow`): Android emulators ace boots open their own window too. */
export const emulatorWindowSwitch = {
  title: "Show emulator window",
  description: "Shows its sensor and camera controls. Applies from the next boot.",
} as const;

/** Each tool's name as people know it. */
export const toolchainNames: Record<Toolchain["id"], string> = {
  git: "Git",
  xcode: "iOS Simulator",
  "serve-sim": "Simulator streaming",
  android: "Android emulators",
};

/** Where to get the tools ace can't install itself. */
export const toolchainInstallers = {
  xcode: { href: "https://apps.apple.com/app/xcode/id497799835", label: "Install Xcode" },
  android: { href: "https://developer.android.com/studio", label: "Install Android Studio" },
} as const;

/** The words around the tool rows: their check, and ace's own download of simulator streaming. */
export const toolWords = {
  checkAgain: "Check again",
  problem: "Couldn't check the tools.",
  download: "Download",
  downloading: "Downloading…",
  downloadFailed: "Couldn't download the simulator tools",
} as const;

/** The tools Settings › Simulators lists, in its order. */
export const simulatorToolIds = ["xcode", "serve-sim", "android"] as const;

export interface ToolchainRow {
  id: Toolchain["id"];
  name: string;
  ready: boolean;
  /** "Ready" or "Not installed". */
  status: string;
  /** The version when ready ("26.0"), else what to do about it; empty when there's nothing. */
  detail: string;
  /** Where to get it, for a missing tool ace can't install itself. */
  installer: { href: string; label: string } | null;
}

export function toolchainRow(tool: Toolchain): ToolchainRow {
  const installer =
    !tool.available && (tool.id === "xcode" || tool.id === "android")
      ? toolchainInstallers[tool.id]
      : null;
  return {
    id: tool.id,
    name: toolchainNames[tool.id],
    ready: tool.available,
    status: tool.available ? "Ready" : "Not installed",
    detail: tool.available ? (tool.version ?? "") : tool.hint,
    installer,
  };
}
