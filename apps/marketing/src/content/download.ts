import type { Platform } from "./release-pick.ts";

/*
 * The download page's words (pages/download.astro): the devices in its opening row, and for
 * each platform its installers and how to install it in three steps. The links themselves come
 * from release.ts; the builds listed here follow apps/desktop/scripts/package.ts.
 */

/** A desktop platform, or the phone and tablet apps. */
export type DeviceId = Platform | "phone";

export const downloadPage = {
  title: "Download ace for Mac, Windows, Linux, iPhone and iPad",
  description:
    "Download ace, the free open-source app for Claude Code, Codex and Cursor, on Mac, Windows and Linux, with apps for iPhone and iPad, and Android coming soon.",
  headline: "Download ace.",
  intro:
    "Free and open source. Install it on every computer you run agents on, then follow them from your iPhone or iPad.",
  /** Follows the version in the intro. */
  latest: "The latest release is ace",
  tabsHeading: "Install it on anything you own.",
  tabsLabel: "Platforms",
  updates: "ace updates itself, on the Stable channel or, if you like, Beta.",
  allBuilds: "Every build and checksum",
  before:
    "ace runs the coding-agent CLIs you already use. Install at least one, such as Claude Code, Codex or Cursor, and sign in to it the usual way.",
  agentsLink: "Every supported agent",
  questionsHeading: "Before you download",
} as const;

export interface PlatformGuide {
  id: DeviceId;
  /** The tab's name. */
  tab: string;
  /** The label over its device in the opening row: the device, then its system. */
  device: string;
  system: string;
  /** One line under the platform's name. */
  line: string;
  /** Each kind of build: its format and the chips it is made for. */
  files: { format: string; chips: string }[];
  steps: [string, string, string];
}

export const platformGuides: PlatformGuide[] = [
  {
    id: "mac",
    tab: "Mac",
    device: "Mac",
    system: "macOS",
    line: "For Apple silicon and Intel Macs.",
    files: [
      { format: "Disk image (.dmg)", chips: "Apple silicon · Intel" },
      { format: "Zip archive (.zip)", chips: "Apple silicon · Intel" },
    ],
    steps: [
      "Open the disk image and drag ace to Applications.",
      "Open ace. It finds the agent CLIs you're already signed in to.",
      "Choose a project folder and start your first thread.",
    ],
  },
  {
    id: "windows",
    tab: "Windows",
    device: "Windows",
    system: "PC",
    line: "For x64 and Arm PCs.",
    files: [{ format: "Installer (.exe)", chips: "x64 · Arm64" }],
    steps: [
      "Run the installer and follow its steps.",
      "Open ace from the Start menu. It finds the agent CLIs you're signed in to.",
      "Choose a project folder and start your first thread.",
    ],
  },
  {
    id: "linux",
    tab: "Linux",
    device: "Linux",
    system: "laptop",
    line: "For x64 and Arm64, on any recent distribution.",
    files: [
      { format: "AppImage", chips: "x64 · Arm64" },
      { format: "Debian package (.deb)", chips: "x64 · Arm64" },
      { format: "Archive (.tar.gz)", chips: "x64 · Arm64" },
    ],
    steps: [
      "Make the AppImage executable and run it, or install the .deb with apt.",
      "Open ace. It finds the agent CLIs you're signed in to.",
      "Choose a project folder and start your first thread.",
    ],
  },
  {
    id: "phone",
    tab: "iPhone and iPad",
    device: "iPhone",
    system: "iOS",
    line: "Follow and steer the agents on your computers from anywhere.",
    files: [
      { format: "Push notifications", chips: "For approvals and questions" },
      { format: "Live Activities", chips: "A thread's progress on the Lock Screen" },
      { format: "Widgets", chips: "Your threads at a glance" },
      { format: "Allow and Deny", chips: "Right on the Lock Screen" },
    ],
    steps: [
      "Install ace on a computer first: your agents run there, not on the phone.",
      "Pair: scan the code ace shows, or sign in to the same ace account on both.",
      "Allow notifications, and answer approvals from the Lock Screen.",
    ],
  },
];

/** Under the phone's panel. */
export const phoneNotes = {
  more: { href: "/features/mobile/", label: "How the iPhone and iPad apps work" },
  android: "Android is coming soon. Until then, any browser can pair with your machines.",
} as const;
