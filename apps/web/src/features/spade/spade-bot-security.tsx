import { spadeGrantSentence, type SpadeBotSecurity } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingFooter, SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useNativePicker } from "@/lib/native-picker.ts";
import { ProfileCheckpoints, ProfileEgress } from "./spade-bot-checkpoints.tsx";
import { ProfileNetwork } from "./spade-bot-network.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { fault } from "./spade-profile-actions.ts";
import { ProfileEmpty, ProfileSection } from "./spade-profile-parts.tsx";
import { addGrant, botSecurityKey, removeGrant, useBotSecurity } from "./spade-security-api.ts";
import { Refusal } from "./spade-settings-rows.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/**
 * The bot's boundaries (ADR 0167), sections of Details: its folders, its grants, its network,
 * its checkpoints and its network activity. Without a Spade that has them (or while it can't
 * answer) they aren't there.
 */
export function ProfileSecurity(props: { bot: RosterBot }) {
  const security = useBotSecurity(props.bot.id);
  const data = security.data;
  if (!data) return null;
  return (
    <>
      <ProfileFolders bot={props.bot} security={data} />
      <ProfileGrants bot={props.bot} security={data} />
      <ProfileNetwork bot={props.bot} security={data} />
      <ProfileCheckpoints bot={props.bot} />
      <ProfileEgress bot={props.bot} />
    </>
  );
}

/** Saves a grant change, then reads the bot's boundaries again; a refusal comes back in words. */
function useGrantChange(bot: RosterBot) {
  const cache = useQueryClient();
  const machine = useSpadeMachine().key;
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const run = async (change: () => Promise<unknown>) => {
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
  return { saving, refusal, run };
}

const access = [
  { value: "read", label: "Read" },
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
    <ProfileSection label="Folders">
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
      <SettingFooter className="justify-start">
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed) add(typed);
          }}
        >
          <Input
            aria-label="Folder path"
            placeholder="Add a folder"
            value={path}
            className="min-w-0 flex-1"
            disabled={change.saving}
            onChange={(event) => setPath(event.target.value)}
          />
          <Select<"read" | "write">
            label="Access"
            className="w-36 shrink-0"
            value={write}
            options={access}
            onValueChange={setWrite}
          />
          {picker && !typed ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={change.saving}
              onClick={() => void picker.choose().then((chosen) => chosen && add(chosen))}
            >
              Choose…
            </Button>
          ) : (
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={change.saving || !typed.startsWith("/")}
            >
              Add folder
            </Button>
          )}
        </form>
      </SettingFooter>
      {change.refusal && (
        <p data-setting-slot="" className="py-2 text-xs">
          <Refusal>{change.refusal}</Refusal>
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
          <Refusal>{change.refusal}</Refusal>
        </p>
      )}
    </ProfileSection>
  );
}
