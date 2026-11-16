import { formatBytes } from "@ace/ui-core/byte-size";
import { spadeEgressRows, spadePastTime, type SpadeCheckpoint } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useNow } from "@/lib/time.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { ProfileSection } from "./spade-profile-parts.tsx";
import { personZone } from "./spade-routines-api.ts";
import {
  botSecurityKey,
  readCheckpoints,
  readEgress,
  restoreCheckpoint,
} from "./spade-security-api.ts";
import { SpadeRequestError } from "./spade-requests.ts";
import { Refusal } from "./spade-settings-rows.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

const reasons: Record<string, string> = {
  auto: "Automatic",
  person: "Taken by you",
  before_restore: "Before a restore",
};

/** Why Spade refused a restore, in the profile's words: the bot busy, or a restore running. */
function refusedWords(name: string, error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof SpadeRequestError && error.status === 409) {
    if (message.includes("services")) return `${name}'s services are running. Stop them first.`;
    if (message.includes("being restored")) return "A restore is already running.";
    return `${name} is working. Stop it first.`;
  }
  return message || "Try again.";
}

/**
 * Checkpoints (ADR 0167), a section of Details: copies of the bot's workspace, newest first, each
 * with Restore behind a confirm. Spade keeps how the workspace is now as a checkpoint first, and
 * refuses while the bot works; that refusal stays as one line under the list.
 */
export function ProfileCheckpoints(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const now = useNow();
  const key = botSecurityKey(machine, bot.id, "checkpoints");
  const list = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readCheckpoints(client, bot.id, signal),
    retry: false,
  });
  const [confirming, setConfirming] = useState<Confirming>();
  const [refusal, setRefusal] = useState<string>();
  const [restoring, setRestoring] = useState(false);
  const restore = async (checkpoint: SpadeCheckpoint) => {
    setRestoring(true);
    setRefusal(undefined);
    try {
      await restoreCheckpoint(client, bot.id, checkpoint.id);
    } catch (error) {
      setRefusal(refusedWords(bot.name, error));
    } finally {
      setRestoring(false);
      await cache.invalidateQueries({ queryKey: key });
    }
  };
  const checkpoints = list.data;
  if (!checkpoints || checkpoints.length === 0) return null;
  const zone = personZone();
  return (
    <ProfileSection label="Checkpoints">
      {checkpoints.map((checkpoint) => {
        const when = spadePastTime(checkpoint.at, { now, timeZone: zone });
        return (
          <SettingRow
            key={checkpoint.id}
            title={when}
            description={reasons[checkpoint.reason] ?? checkpoint.reason}
            density="compact"
            inline
          >
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Restore ${when}`}
              disabled={restoring}
              onClick={() =>
                setConfirming({
                  title: `Restore ${bot.name}'s workspace?`,
                  body: `Its files go back to how they were at ${when}. How they are now is kept as a checkpoint first.`,
                  confirm: "Restore",
                  run: () => void restore(checkpoint),
                })
              }
            >
              Restore
            </Button>
          </SettingRow>
        );
      })}
      {refusal && (
        <p data-setting-slot="" className="py-2 text-xs">
          <Refusal>{refusal}</Refusal>
        </p>
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </ProfileSection>
  );
}

/**
 * Network activity (ADR 0167), a section of Details: each connection the bot's commands made
 * through Spade, newest first, with its host, the bytes either way and when. Refused ones say
 * why. None, no section.
 */
export function ProfileEgress(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const now = useNow();
  const log = useQuery({
    queryKey: botSecurityKey(machine, bot.id, "egress"),
    queryFn: ({ signal }) => readEgress(client, bot.id, signal),
    retry: false,
  });
  const rows = log.data ? spadeEgressRows(log.data) : [];
  if (rows.length === 0) return null;
  const zone = personZone();
  return (
    <ProfileSection label="Network activity">
      {rows.map((row) => (
        <SettingRow
          key={row.key}
          title={row.host}
          description={
            row.refused ?? `${formatBytes(row.received)} received · ${formatBytes(row.sent)} sent`
          }
          density="compact"
          inline
        >
          <span className="text-xs text-subtle-foreground tabular-nums">
            {spadePastTime(row.at, { now, timeZone: zone })}
          </span>
        </SettingRow>
      ))}
    </ProfileSection>
  );
}
