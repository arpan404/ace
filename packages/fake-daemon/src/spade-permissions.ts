import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * A bot's Permissions in the fake Spade API (ADR 0171, amendment 7), in the shapes of
 * spade/crates/spade-server/src/security/permissions.rs: per bot the switches it sets itself,
 * the machine's defaults and the apps bots never use. Commands and Network are the security
 * fake's own `commands` and network settings; the security fake joins them. A test sets
 * `standing` false to answer a raise as ace's daemon does for a window that hasn't proved it is
 * the person's.
 */

export type FakeSpadePermissionKey =
  | "computer_use"
  | "browser"
  | "devices"
  | "apps"
  | "commands"
  | "network"
  | "send"
  | "pay";

export const fakeSpadePermissionKeys: readonly FakeSpadePermissionKey[] = [
  "computer_use",
  "browser",
  "devices",
  "apps",
  "commands",
  "network",
  "send",
  "pay",
];

/** The switches kept here: everything but Commands and Network. */
export type FakeSpadeKeptKey = Exclude<FakeSpadePermissionKey, "commands" | "network">;

export const fakeSpadeNeverApps = [
  "1Password",
  "Bitwarden",
  "Dashlane",
  "KeePassXC",
  "LastPass",
  "Passwords",
  "Keychain Access",
  "Authenticator",
  "Bank",
  "Wallet",
  "PayPal",
  "Venmo",
  "Cash App",
  "Coinbase",
];

/** What ace's daemon answers a raise from a window without the person's standing. */
export const fakeStandingRefusal = "Confirm your identity to continue.";

const kept = (key: FakeSpadePermissionKey): key is FakeSpadeKeptKey =>
  key !== "commands" && key !== "network";

export const isFakePermissionKey = (key: unknown): key is FakeSpadePermissionKey =>
  typeof key === "string" && (fakeSpadePermissionKeys as readonly string[]).includes(key);

export class FakeSpadePermissions {
  /** Whether the window proved the person's standing; false refuses every raise. */
  standing = true;
  /** The machine's defaults, over Spade's (driving off; apps, sends and payments on). */
  defaults: Record<FakeSpadeKeptKey, boolean> = {
    computer_use: false,
    browser: false,
    devices: false,
    apps: true,
    send: true,
    pay: true,
  };
  neverApps = [...fakeSpadeNeverApps];
  /** Each bot's own switches; a missing one follows the default. */
  readonly bots = new Map<string, Partial<Record<FakeSpadeKeptKey, boolean>>>();

  own(bot: string): Partial<Record<FakeSpadeKeptKey, boolean>> {
    let own = this.bots.get(bot);
    if (!own) {
      own = {};
      this.bots.set(bot, own);
    }
    return own;
  }

  /** A switch kept here, as it holds for `bot` (workers aren't modelled). */
  on(bot: string, key: FakeSpadeKeptKey): boolean {
    return this.bots.get(bot)?.[key] ?? this.defaults[key];
  }

  /** `permissions` of a bot's view, given how its Commands and Network read. */
  view(bot: string, joined: { commands: [boolean, boolean]; network: [boolean, boolean] }) {
    const on: Record<string, boolean> = {};
    const own: Record<string, boolean> = {};
    for (const key of fakeSpadePermissionKeys) {
      if (kept(key)) {
        on[key] = this.on(bot, key);
        own[key] = this.bots.get(bot)?.[key] !== undefined;
      } else {
        [on[key], own[key]] = joined[key];
      }
    }
    return { on, own, never_apps: this.neverApps };
  }

  /** `permissions` of the machine's view. */
  machineView(joined: { commands: boolean; network: boolean }) {
    const on: Record<string, boolean> = {};
    for (const key of fakeSpadePermissionKeys)
      on[key] = kept(key) ? this.defaults[key] : joined[key];
    return { on, never_apps: this.neverApps };
  }

  /** Why a raise isn't made: the daemon refuses it for a window without standing. */
  refusal(): FakeSpadeAnswer | undefined {
    return this.standing ? undefined : { status: 403, refused: fakeStandingRefusal };
  }

  /** Sets a bot's own switch kept here (`null` follows). */
  set(bot: string, key: FakeSpadeKeptKey, on: boolean | null) {
    const own = this.own(bot);
    if (on === null) delete own[key];
    else own[key] = on;
  }

  isKept = kept;
}
