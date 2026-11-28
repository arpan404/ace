import {
  spadeGrantSentence,
  spadeMachinePlace,
  type SpadeBotSecurity,
} from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, useRef } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useNativePicker } from "@/lib/native-picker.ts";
import { AutonomyChoice } from "./spade-autonomy-choice.tsx";
import { ProfileCheckpoints, ProfileEgress } from "./spade-bot-checkpoints.tsx";
import { CommandsChoice } from "./spade-commands-choice.tsx";
import { ProfileNetworkRows } from "./spade-bot-network.tsx";
import { ProfilePackageEffects } from "./spade-bot-package-effects.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { fault } from "./spade-profile-actions.ts";
import {
  ProfileCardSkeleton,
  ProfileEmpty,
  ProfileProblem,
  ProfileSection,
  sectionActionClass,
} from "./spade-profile-parts.tsx";
import {
  addGrant,
  botSecurityKey,
  removeGrant,
  setBotAutonomy,
  setBotCommands,
  useBotSecurity,
  useSecurityMachine,
} from "./spade-security-api.ts";
import { Refusal } from "./spade-settings-rows.tsx";
import { agentsKey, type RosterBot } from "./use-spade-roster.ts";

const alwaysAsksRows = [
  { title: "Pay", description: "Purchases, payments and billing changes." },
  { title: "Send as you", description: "Emails, messages and posts sent under your name." },
  { title: "Change access", description: "Permissions, connected apps and security rules." },
] as const;

/**
 * The bot's boundaries (ADR 0167), sections of Details: its folders, its grants, where its
 * commands run and what it may reach, its checkpoints and its network activity. Without a Spade
 * that has them (or while it can't answer) they aren't there.
 */
export function ProfileSecurity(props: { bot: RosterBot }) {
  const security = useBotSecurity(props.bot.id);
  const data = security.data;
  if (!data) return null;
  return (
    <>
      <ProfileFolders bot={props.bot} security={data} />
      <ProfileGrants bot={props.bot} security={data} />
      <ProfileBoundaries bot={props.bot} security={data} />
      <ProfileCheckpoints bot={props.bot} />
      <ProfileEgress bot={props.bot} />
    </>
  );
}

/** How it decides, what always asks, and where its commands run and what it may reach. */
export function ProfileDecides(props: { bot: RosterBot }) {
  const security = useBotSecurity(props.bot.id);
  if (security.isPending)
    return (
      <ProfileSection label="Decision mode" flush>
        <ProfileCardSkeleton label="security settings" rows={2} lines={2} />
      </ProfileSection>
    );
  if (security.isError || !security.data)
    return (
      <ProfileSection label="Decision mode">
        <ProfileProblem
          text="Couldn't read how this bot decides."
          onRetry={() => void security.refetch()}
        />
      </ProfileSection>
    );
  return <ProfileBoundaries bot={props.bot} security={security.data} />;
}

/** Its folders and grants. */
export function ProfileFilesAndGrants(props: { bot: RosterBot }) {
  const security = useBotSecurity(props.bot.id);
  if (security.isPending)
    return (
      <ProfileSection label="Folders" flush>
        <ProfileCardSkeleton label="folders" rows={2} lines={1} />
      </ProfileSection>
    );
  if (security.isError || !security.data)
    return (
      <ProfileSection label="Folders">
        <ProfileProblem
          text="Couldn't read its folders and grants."
          onRetry={() => void security.refetch()}
        />
      </ProfileSection>
    );
  return (
    <>
      <ProfileFolders bot={props.bot} security={security.data} />
      <ProfileGrants bot={props.bot} security={security.data} />
    </>
  );
}

/** Its checkpoints and its network activity. */
export function ProfileSafetyLogs(props: { bot: RosterBot }) {
  const data = useBotSecurity(props.bot.id).data;
  if (!data) return null;
  return (
    <>
      <ProfileCheckpoints bot={props.bot} />
      <ProfileEgress bot={props.bot} />
    </>
  );
}

/**
 * How the bot decides (ADR 0163, amendment 2), what always asks, what its package may do
 * (ADR 0200 §3.4), then where its commands run and what it may reach (ADR 0171).
 */
function ProfileBoundaries(props: { bot: RosterBot; security: SpadeBotSecurity }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const place = spadeMachinePlace(useSecurityMachine().data?.platform);
  const [setting, setSetting] = useState(false);
  const { security } = props;
  const own = security.own.commands || security.own.network || security.own.pluginNetwork;
  const settings = (
    <Link to="/settings/spade/security" className={sectionActionClass}>
      Security settings
    </Link>
  );
  return (
    <>
      <ProfileSection label="Decision mode">
        <AutonomyChoice
          variant="segmented"
          title="How it decides"
          value={security.autonomy}
          who={props.bot.name}
          confirmed={security.fullAccessConfirmed}
          save={async (choice) => {
            cache.setQueryData(
              botSecurityKey(machine, props.bot.id, "bot"),
              await setBotAutonomy(client, props.bot.id, choice),
            );
            // The bot's conversation says when it is in Full access: read the bots again.
            await cache.invalidateQueries({ queryKey: agentsKey });
          }}
        />
      </ProfileSection>
      <ProfileSection
        label="Always asks you"
        note="These always need your approval, even in Full access."
      >
        {alwaysAsksRows.map((row) => (
          <SettingRow
            key={row.title}
            title={row.title}
            description={row.description}
            density="compact"
            inline
          />
        ))}
      </ProfileSection>
      <ProfileSection label="Security" actions={settings}>
        <ProfilePackageEffects bot={props.bot} />
        {!own && !setting ? (
          <SettingRow
            title={`Same as ${place}`}
            description="Commands and network follow this computer's security settings."
            density="compact"
            inline
          >
            <Button size="sm" variant="ghost" onClick={() => setSetting(true)}>
              Set its own
            </Button>
          </SettingRow>
        ) : (
          <>
            <CommandsChoice
              title="Commands run"
              value={security.own.commands ? security.commands : "inherit"}
              effective={security.commands}
              inherit={`Same as ${place}`}
              compact
              save={async (choice) =>
                cache.setQueryData(
                  botSecurityKey(machine, props.bot.id, "bot"),
                  await setBotCommands(client, props.bot.id, choice === "inherit" ? null : choice),
                )
              }
            />
            <ProfileNetworkRows bot={props.bot} security={security} place={place} />
          </>
        )}
      </ProfileSection>
    </>
  );
}

/** Saves a grant change, then reads the bot's boundaries again; a refusal comes back in words. */
function useGrantChange(bot: RosterBot) {
  const cache = useQueryClient();
  const machine = useSpadeMachine().key;
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  // The change last tried, made again once the person confirms it's them.
  const last = useRef<() => Promise<unknown>>(undefined);
  const run = async (change: () => Promise<unknown>) => {
    last.current = change;
    setSaving(true);
    setRefusal(undefined);
    try {
      await change();
      return true;
    } catch (error) {
      setRefusal(fault(error));
      return false;
    } finally {
      setSaving(false);
      await cache.invalidateQueries({ queryKey: botSecurityKey(machine, bot.id, "bot") });
    }
  };
  const retry = () => {
    if (last.current) void run(last.current);
  };
  return { saving, refusal, run, retry };
}

const access = [
  { value: "read", label: "Read only" },
  { value: "write", label: "Read and write" },
] as const;

/** Folders the bot may read, or read and write, in its sandbox; added by path or the picker. */
function ProfileFolders(props: { bot: RosterBot; security: SpadeBotSecurity }) {
  const { bot } = props;
  const client = useSpadeClient();
  const change = useGrantChange(bot);
  const picker = useNativePicker(bot.machine.primary);
  const [path, setPath] = useState("");
  const [write, setWrite] = useState<"read" | "write">("read");
  const typed = path.trim();
  const add = (folder: string) =>
    void change
      .run(() =>
        addGrant(client, bot.id, { kind: "folder", path: folder, write: write === "write" }),
      )
      .then((saved) => saved && setPath(""));
  return (
    <ProfileSection
      label="Folders"
      note="Folders outside this bot's workspace that it can access inside its sandbox."
    >
      {props.security.folders.length === 0 && <ProfileEmpty>Only its own workspace.</ProfileEmpty>}
      {props.security.folders.map((folder) => (
        <SettingRow
          key={folder.grant}
          title={folder.path.split("/").findLast(Boolean) ?? folder.path}
          description={`${folder.path} · ${folder.write ? "Read and write" : "Read"}`}
          density="compact"
          inline
        >
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${folder.path}`}
            disabled={change.saving}
            onClick={() => void change.run(() => removeGrant(client, bot.id, folder.grant))}
          >
            Remove
          </Button>
        </SettingRow>
      ))}
      {/* The path on its own line, then its access and the button: one height, one left edge. */}
      <form
        data-setting-slot=""
        className="flex flex-col gap-2 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (typed) add(typed);
        }}
      >
        <Input
          aria-label="Folder path"
          placeholder="/path/to/folder"
          value={path}
          disabled={change.saving}
          onChange={(event) => setPath(event.target.value)}
        />
        <div className="flex items-center gap-2">
          <Select<"read" | "write">
            label="Access"
            className="min-w-0 flex-1"
            value={write}
            options={access}
            onValueChange={setWrite}
          />
          {picker && !typed ? (
            <Button
              variant="secondary"
              className="h-8 shrink-0 rounded-md"
              disabled={change.saving}
              onClick={() => void picker.choose().then((chosen) => chosen && add(chosen))}
            >
              Choose…
            </Button>
          ) : (
            <Button
              type="submit"
              variant="secondary"
              className="h-8 shrink-0 rounded-md"
              disabled={change.saving || !typed.startsWith("/")}
            >
              Add folder
            </Button>
          )}
        </div>
      </form>
      {change.refusal && (
        <p data-setting-slot="" className="py-2 text-xs">
          <Refusal onConfirmed={change.retry}>{change.refusal}</Refusal>
        </p>
      )}
    </ProfileSection>
  );
}

/** What the bot may do without asking, each a sentence with Remove. None, no section. */
function ProfileGrants(props: { bot: RosterBot; security: SpadeBotSecurity }) {
  const { bot } = props;
  const client = useSpadeClient();
  const change = useGrantChange(bot);
  const grants = props.security.grants.filter((grant) => grant.kind !== "folder");
  if (grants.length === 0) return null;
  return (
    <ProfileSection label="Grants">
      {grants.map((grant) => {
        const sentence = spadeGrantSentence(grant);
        return (
          <SettingRow key={grant.id} title={sentence} density="compact" inline>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove: ${sentence}`}
              disabled={change.saving}
              onClick={() => void change.run(() => removeGrant(client, bot.id, grant.id))}
            >
              Remove
            </Button>
          </SettingRow>
        );
      })}
      {change.refusal && (
        <p data-setting-slot="" className="py-2 text-xs">
          <Refusal onConfirmed={change.retry}>{change.refusal}</Refusal>
        </p>
      )}
    </ProfileSection>
  );
}
