import { useState, useSyncExternalStore } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { ProfileSection } from "./spade-profile-parts.tsx";

/*
 * What a bot may do, as one list of switches (the founder's Permissions): the same list as each
 * bot's own Permissions tab and as the default for every bot in Settings › Spade › Security.
 * A bot's switch follows the default until the person sets it, and says so.
 *
 * PROTOTYPE: Spade's permission API is being built on ace/computer-use-fewer-asks. Until it
 * lands, choices are kept in this browser only (`spade.permissions.*` in localStorage), so the
 * screens can be tried; the store below is what the API replaces.
 */

export const permissionKinds = [
  { id: "computer", title: "Computer use", line: "Uses apps on this Mac with the mouse and keys." },
  { id: "browser", title: "Browser", line: "Opens and acts in web pages in its own browser." },
  {
    id: "devices",
    title: "Simulators and devices",
    line: "Drives simulators, emulators and paired phones.",
  },
  { id: "apps", title: "Apps", line: "Uses the apps you connected for it." },
  {
    id: "commands",
    title: "Commands outside the sandbox",
    line: "Runs commands with your access instead of sealed off.",
  },
  {
    id: "network",
    title: "Network beyond listed sites",
    line: "Reaches any site, not only the listed ones.",
  },
  { id: "send", title: "Send as you", line: "Sends mail and messages in your name." },
  { id: "pay", title: "Payments", line: "Pays or buys with your accounts." },
] as const;

export type PermissionKind = (typeof permissionKinds)[number]["id"];
export type Permissions = Partial<Record<PermissionKind, boolean>>;

/** Out of the box: what's safe on, what touches money, messages or the whole machine off. */
export const defaultPermissions: Record<PermissionKind, boolean> = {
  computer: false,
  browser: true,
  devices: false,
  apps: true,
  commands: false,
  network: false,
  send: false,
  pay: false,
};

/** A bot's switch: its own choice, else the default's. */
export function permissionOf(
  kind: PermissionKind,
  own: Permissions,
  defaults: Permissions,
): { on: boolean; own: boolean } {
  const mine = own[kind];
  if (mine !== undefined) return { on: mine, own: true };
  return { on: defaults[kind] ?? defaultPermissions[kind], own: false };
}

// The prototype's store: one key per scope, read through useSyncExternalStore.
const listeners = new Set<() => void>();
const keyOf = (scope: string) => `spade.permissions.${scope}`;
const cache = new Map<string, { raw: string | null; value: StoredPermissions }>();

interface StoredPermissions {
  switches: Permissions;
  never: string[];
}

function read(scope: string): StoredPermissions {
  const raw = globalThis.localStorage?.getItem(keyOf(scope)) ?? null;
  const held = cache.get(scope);
  if (held && held.raw === raw) return held.value;
  let value: StoredPermissions = { switches: {}, never: [] };
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    if (parsed && typeof parsed === "object") {
      const record = parsed as { switches?: unknown; never?: unknown };
      value = {
        switches:
          record.switches && typeof record.switches === "object"
            ? (record.switches as Permissions)
            : {},
        never: Array.isArray(record.never)
          ? record.never.filter((each): each is string => typeof each === "string")
          : [],
      };
    }
  } catch {
    // A value this build can't read starts over.
  }
  cache.set(scope, { raw, value });
  return value;
}

function write(scope: string, value: StoredPermissions) {
  globalThis.localStorage?.setItem(keyOf(scope), JSON.stringify(value));
  for (const listener of listeners) listener();
}

function usePermissionStore(scope: string) {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => read(scope),
  );
  return {
    value,
    set: (next: StoredPermissions) => write(scope, next),
  };
}

/** The switches, for one bot (`bot`) or the default for every bot. */
export function PermissionSwitches(props: { bot?: { id: string; name: string } | undefined }) {
  const defaults = usePermissionStore("default");
  const own = usePermissionStore(props.bot ? `bot.${props.bot.id}` : "default");
  const scope = props.bot ? own : defaults;
  const setSwitch = (kind: PermissionKind, on: boolean) =>
    scope.set({ ...scope.value, switches: { ...scope.value.switches, [kind]: on } });
  const followDefault = (kind: PermissionKind) => {
    const { [kind]: _, ...rest } = scope.value.switches;
    scope.set({ ...scope.value, switches: rest });
  };
  return (
    <>
      <ProfileSection label="Permissions">
        {permissionKinds.map((kind) => {
          const state = props.bot
            ? permissionOf(kind.id, own.value.switches, defaults.value.switches)
            : { on: defaults.value.switches[kind.id] ?? defaultPermissions[kind.id], own: true };
          return (
            <SettingRow
              key={kind.id}
              title={kind.title}
              description={
                props.bot && !state.own ? (
                  kind.line
                ) : props.bot ? (
                  <>
                    {`${kind.line} Set for ${props.bot.name}. `}
                    <button
                      type="button"
                      className="rounded-sm text-foreground focus-ring hover:underline"
                      onClick={() => followDefault(kind.id)}
                    >
                      Use the default
                    </button>
                  </>
                ) : (
                  kind.line
                )
              }
              density="compact"
              inline
            >
              <Switch
                aria-label={kind.title}
                checked={state.on}
                onCheckedChange={(on) => setSwitch(kind.id, on)}
              />
            </SettingRow>
          );
        })}
      </ProfileSection>
      <NeverList
        scope={scope}
        name={props.bot ? props.bot.name : "Bots"}
        inherited={props.bot ? defaults.value.never : []}
      />
    </>
  );
}

/** Apps no bot may open with Computer use, whatever its switches say. */
function NeverList(props: {
  scope: ReturnType<typeof usePermissionStore>;
  name: string;
  inherited: readonly string[];
}) {
  const [adding, setAdding] = useState("");
  const { value, set } = props.scope;
  const add = () => {
    const app = adding.trim();
    if (!app || value.never.includes(app)) return;
    set({ ...value, never: [...value.never, app] });
    setAdding("");
  };
  return (
    <ProfileSection label={`Never let ${props.name === "Bots" ? "bots" : props.name} use`}>
      {props.inherited.map((app) => (
        <SettingRow
          key={`all:${app}`}
          title={app}
          description="For every bot"
          density="compact"
          inline
        />
      ))}
      {value.never.map((app) => (
        <SettingRow key={app} title={app} density="compact" inline>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Let bots use ${app} again`}
            onClick={() => set({ ...value, never: value.never.filter((each) => each !== app) })}
          >
            Remove
          </Button>
        </SettingRow>
      ))}
      <form
        className="flex items-center gap-2 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input
          aria-label="An app bots may never use"
          placeholder="An app, such as 1Password or Messages"
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
        />
        <Button size="sm" type="submit" variant="secondary" disabled={!adding.trim()}>
          Add
        </Button>
      </form>
    </ProfileSection>
  );
}
