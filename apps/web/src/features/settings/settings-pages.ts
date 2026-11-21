import {
  BellSimpleIcon,
  ClipboardTextIcon,
  HardDrivesIcon,
  LockSimpleIcon,
  PackageIcon,
  SlidersHorizontalIcon,
  UsersThreeIcon,
  CodeIcon,
  RobotIcon,
  DatabaseIcon,
  DeviceMobileIcon,
  DevicesIcon,
  FlaskIcon,
  GearSixIcon,
  GitBranchIcon,
  GlobeSimpleIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  KeyboardIcon,
  PaletteIcon,
  ShieldIcon,
  AppWindowIcon,
  TerminalWindowIcon,
  UserCircleIcon,
  WrenchIcon,
} from "@ace/icons";
import { ComputerUseIcon, SpadeIcon } from "@/components/ace-icons.tsx";
import type { IconGlyph } from "@/components/icon.tsx";
import { orgAllows, type OrgPermission } from "@ace/client/ace-org";

export type SettingsPath =
  | "/settings/profile"
  | "/settings/organization"
  | "/settings/organization/sign-in"
  | "/settings/organization/hosts"
  | "/settings/organization/policy"
  | "/settings/organization/registry"
  | "/settings/organization/audit"
  | "/settings/prompts"
  | "/settings/general"
  | "/settings/agents"
  | "/settings/appearance"
  | "/settings/editor"
  | "/settings/providers"
  | "/settings/notifications"
  | "/settings/source-control"
  | "/settings/remote"
  | "/settings/computer-use"
  | "/settings/spade"
  | "/settings/spade/models"
  | "/settings/spade/search"
  | "/settings/spade/apps"
  | "/settings/spade/security"
  | "/settings/browser"
  | "/settings/simulators"
  | "/settings/keyboard"
  | "/settings/advanced"
  | "/settings/beta"
  | "/settings/storage";

/**
 * Where a page's settings live. `profile`: the person's ace account, first and untitled.
 * `machine`: on the environment picked at the top of the Settings
 * sidebar, for every device that uses it. `device`: only on the screen in use, whatever
 * environment is picked. `network`: how machines and devices reach each other.
 */
export type SettingsGroup = "profile" | "machine" | "device" | "network";

export interface SettingsPage {
  to: SettingsPath;
  /** The page's heading, and its name in search results. */
  title: string;
  icon: IconGlyph;
  group: SettingsGroup;
  /**
   * Pages of one place listed under its own label in the nav ("Spade"), after the group they
   * belong to; `nav` is the row's name there when it differs from the heading.
   */
  section?: { label: string; nav?: string };
}

export const settingsGroupTitles: Record<SettingsGroup, string | undefined> = {
  profile: undefined,
  machine: "Environment",
  device: "This device",
  network: "Connections",
};

/** A page of Settings › Spade's group, `nav` naming its row when the heading doesn't. */
const spade = (nav?: string) => ({ label: "Spade", ...(nav ? { nav } : {}) });

/** Settings › Spade: five pages on the machine Spade runs on, under a "Spade" label. */
function spadePages(): SettingsPage[] {
  return [
    {
      to: "/settings/spade",
      title: "Spade",
      icon: SpadeIcon,
      group: "machine",
      section: spade("General"),
    },
    {
      to: "/settings/spade/models",
      title: "Models",
      icon: KeyIcon,
      group: "machine",
      section: spade(),
    },
    {
      to: "/settings/spade/search",
      title: "Web search",
      icon: MagnifyingGlassIcon,
      group: "machine",
      section: spade(),
    },
    {
      to: "/settings/spade/apps",
      title: "Apps",
      icon: AppWindowIcon,
      group: "machine",
      section: spade(),
    },
    {
      to: "/settings/spade/security",
      title: "Security",
      icon: ShieldIcon,
      group: "machine",
      section: spade(),
    },
  ];
}

/** A page of Settings › Organization, `nav` naming its row when the heading doesn't. */
const organization = (nav?: string) => ({ label: "Organization", ...(nav ? { nav } : {}) });

/**
 * Settings › Organization (ADR 0206 §2.7): the window's organization, in its space only. Each
 * page names what a role needs to see it; every member sees Members and Hosts.
 */
const organizationPages: readonly (SettingsPage & { needs?: OrgPermission })[] = [
  {
    to: "/settings/organization",
    title: "Members",
    icon: UsersThreeIcon,
    group: "profile",
    section: organization(),
  },
  {
    to: "/settings/organization/sign-in",
    title: "Sign-in",
    icon: LockSimpleIcon,
    group: "profile",
    section: organization(),
    needs: "sso:manage",
  },
  {
    to: "/settings/organization/hosts",
    title: "Hosts",
    icon: HardDrivesIcon,
    group: "profile",
    section: organization(),
  },
  {
    to: "/settings/organization/policy",
    title: "Policy",
    icon: SlidersHorizontalIcon,
    group: "profile",
    section: organization(),
    needs: "policy:set",
  },
  {
    to: "/settings/organization/registry",
    title: "Registry",
    icon: PackageIcon,
    group: "profile",
    section: organization(),
    needs: "registry:publish",
  },
  {
    to: "/settings/organization/audit",
    title: "Audit log",
    icon: ClipboardTextIcon,
    group: "profile",
    section: organization(),
    needs: "audit:read",
  },
];

/** What a role needs to open an Organization page; undefined: every member. */
export function organizationPageNeeds(path: string): OrgPermission | undefined {
  return organizationPages.find((page) => page.to === path)?.needs;
}

/** The Organization pages a member with `role` sees; none outside an organization's space. */
export function visibleOrganizationPages(role: string | undefined): readonly SettingsPage[] {
  if (role === undefined) return [];
  return organizationPages.filter((page) => !page.needs || orgAllows(role, page.needs));
}

const isOrganizationPage = (page: SettingsPage) =>
  organizationPages.some((each) => each.to === page.to);

export const settingsPages: readonly SettingsPage[] = [
  { to: "/settings/profile", title: "Profile", icon: UserCircleIcon, group: "profile" },
  ...organizationPages,
  { to: "/settings/agents", title: "Agents", icon: RobotIcon, group: "machine" },
  { to: "/settings/providers", title: "Providers", icon: TerminalWindowIcon, group: "machine" },
  { to: "/settings/prompts", title: "Prompts", icon: NotePencilIcon, group: "machine" },
  {
    to: "/settings/source-control",
    title: "Source control",
    icon: GitBranchIcon,
    group: "machine",
  },
  { to: "/settings/browser", title: "Browser", icon: GlobeSimpleIcon, group: "machine" },
  { to: "/settings/computer-use", title: "Computer use", icon: ComputerUseIcon, group: "machine" },
  ...spadePages(),
  { to: "/settings/simulators", title: "Simulators", icon: DeviceMobileIcon, group: "machine" },
  { to: "/settings/storage", title: "Storage", icon: DatabaseIcon, group: "machine" },
  { to: "/settings/advanced", title: "Advanced", icon: WrenchIcon, group: "machine" },
  { to: "/settings/beta", title: "Beta", icon: FlaskIcon, group: "machine" },
  { to: "/settings/general", title: "General", icon: GearSixIcon, group: "device" },
  { to: "/settings/appearance", title: "Appearance", icon: PaletteIcon, group: "device" },
  { to: "/settings/editor", title: "Editor", icon: CodeIcon, group: "device" },
  { to: "/settings/notifications", title: "Notifications", icon: BellSimpleIcon, group: "device" },
  { to: "/settings/keyboard", title: "Keyboard", icon: KeyboardIcon, group: "device" },
  { to: "/settings/remote", title: "Fleet", icon: DevicesIcon, group: "network" },
];

const isSpadePage = (page: SettingsPage) =>
  page.to === "/settings/spade" || page.to.startsWith("/settings/spade/");

/**
 * The pages this machine shows: Spade's only while the daemon shows Spade (ADR 0139). The
 * Organization pages are the space's, from `visibleOrganizationPages`.
 */
export function visibleSettingsPages(spadeShown: boolean): readonly SettingsPage[] {
  return settingsPages.filter(
    (page) => !isOrganizationPage(page) && (spadeShown || !isSpadePage(page)),
  );
}

/** The page a path belongs to: itself, else the deepest page it's a sub-page of. */
export function settingsPageOf(pathname: string): SettingsPage | undefined {
  const path = pathname.replace(/\/+$/, "");
  const exact = settingsPages.find((page) => path === page.to);
  if (exact) return exact;
  return settingsPages
    .filter((page) => path.startsWith(`${page.to}/`))
    .reduce<SettingsPage | undefined>(
      (deepest, page) => (deepest && deepest.to.length >= page.to.length ? deepest : page),
      undefined,
    );
}
