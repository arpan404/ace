import {
  spadeNetworkModes,
  spadePrivateHost,
  type SpadeBotSecurity,
  type SpadeNetworkMode,
  type SpadeNetworkPolicy,
} from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  SettingDisclosure,
  SettingFooter,
  SettingList,
  SettingRow,
} from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { fault } from "./spade-profile-actions.ts";
import {
  botSecurityKey,
  resetBotNetwork,
  setBotNetwork,
  useSecurityMachine,
  type SpadeNetworkFor,
} from "./spade-security-api.ts";
import { Refusal } from "./spade-settings-rows.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/**
 * A bot's own network rules (ADR 0167): what its commands and its plugins may reach, each Off,
 * Listed sites or Open; the listed sites (the defaults, which can be removed, and the person's
 * own); and the hosts on a private network it may reach. Saved as changed; a refusal says why
 * under what it came from. Each says whether it is the bot's own or the machine's (ADR 0171),
 * with a way back to the machine's (`place`: "this Mac").
 */
export function ProfileNetworkRows(props: {
  bot: RosterBot;
  security: SpadeBotSecurity;
  place: string;
}) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const defaults = useSecurityMachine().data?.defaults ?? [];
  const show = (view: SpadeBotSecurity) =>
    cache.setQueryData(botSecurityKey(machine, props.bot.id, "bot"), view);
  const rows = (which: SpadeNetworkFor, policy: SpadeNetworkPolicy, own: boolean) => (
    <PolicyRows
      which={which}
      title={which === "commands" ? "Commands reach" : "Plugins reach"}
      named
      policy={policy}
      defaults={defaults}
      own={own}
      place={props.place}
      save={async (next) => show(await setBotNetwork(client, props.bot.id, which, next))}
      inherit={async () => show(await resetBotNetwork(client, props.bot.id, which))}
    />
  );
  return (
    <>
      {rows("commands", props.security.network, props.security.own.network)}
      {rows("plugins", props.security.pluginNetwork, props.security.own.pluginNetwork)}
    </>
  );
}

/**
 * One network rule's rows under `title`: Off, Listed sites or Open, its listed sites and its
 * private hosts, whose titles name `which` when `named` (beside the other rule) and don't under
 * a heading that already does. `own` (a bot's) says whether it is set here or the machine's
 * (`place`), and `inherit` goes back to it.
 */
export function PolicyRows(props: {
  which: SpadeNetworkFor;
  title: string;
  named?: boolean;
  policy: SpadeNetworkPolicy;
  defaults: readonly string[];
  save(next: SpadeNetworkPolicy): Promise<unknown>;
  own?: boolean;
  place?: string;
  inherit?(): Promise<unknown>;
}) {
  const { policy } = props;
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
    }
  };
  const save = (next: SpadeNetworkPolicy) => run(() => props.save(next));
  const sites = policy.allow.filter((entry) => !spadePrivateHost(entry));
  const hosts = policy.allow.filter(spadePrivateHost);
  const without = (entry: string) => policy.allow.filter((each) => each !== entry);
  const inherit = props.inherit;
  const place = props.place ?? "this computer";
  const note = props.own === undefined ? undefined : props.own ? "Its own" : `Same as ${place}`;
  const of = props.named ? ` for ${props.which}` : "";
  return (
    <>
      <SettingRow
        title={props.title}
        description={refusal ? <Refusal>{refusal}</Refusal> : note}
        density="compact"
        inline
      >
        {inherit && props.own && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Use ${place}'s network for ${props.which}`}
            disabled={saving}
            onClick={() => void run(inherit)}
          >
            {`Same as ${place}`}
          </Button>
        )}
        <Select<SpadeNetworkMode>
          label={`Network for ${props.which}`}
          value={policy.mode}
          options={spadeNetworkModes}
          disabled={saving}
          onValueChange={(mode) => void save({ ...policy, mode })}
        />
      </SettingRow>
      {policy.mode === "allow_list" && (
        <SettingDisclosure title={`Listed sites${of}`}>
          <SettingList aria-label={`Listed sites for ${props.which}`}>
            {sites.map((entry) => (
              <EntryRow
                key={entry}
                entry={entry}
                action="Remove"
                disabled={saving}
                onAct={() => void save({ ...policy, allow: without(entry) })}
              />
            ))}
            {props.defaults.map((entry) => {
              const dropped = policy.dropped.includes(entry);
              return (
                <EntryRow
                  key={entry}
                  entry={entry}
                  description={dropped ? "Default, removed" : "Default"}
                  action={dropped ? "Put back" : "Remove"}
                  disabled={saving}
                  onAct={() =>
                    void save({
                      ...policy,
                      dropped: dropped
                        ? policy.dropped.filter((each) => each !== entry)
                        : [...policy.dropped, entry],
                    })
                  }
                />
              );
            })}
          </SettingList>
          <AddEntry
            label="Add a site"
            placeholder="example.com"
            disabled={saving}
            onAdd={(entry) => save({ ...policy, allow: [...policy.allow, entry] })}
          />
        </SettingDisclosure>
      )}
      {policy.mode !== "off" && (
        <SettingDisclosure title={`Private network${of}`}>
          {hosts.length > 0 && (
            <SettingList aria-label={`Private network for ${props.which}`}>
              {hosts.map((entry) => (
                <EntryRow
                  key={entry}
                  entry={entry}
                  action="Remove"
                  disabled={saving}
                  onAct={() => void save({ ...policy, allow: without(entry) })}
                />
              ))}
            </SettingList>
          )}
          <AddEntry
            label="Add a private host"
            placeholder="localhost:3000"
            disabled={saving}
            onAdd={(entry) => save({ ...policy, allow: [...policy.allow, entry] })}
          />
        </SettingDisclosure>
      )}
    </>
  );
}

function EntryRow(props: {
  entry: string;
  description?: string;
  action: string;
  disabled: boolean;
  onAct(): void;
}) {
  return (
    <li>
      <SettingRow title={props.entry} description={props.description} density="compact" inline>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`${props.action} ${props.entry}`}
          disabled={props.disabled}
          onClick={props.onAct}
        >
          {props.action}
        </Button>
      </SettingRow>
    </li>
  );
}

/** A host typed and added; the field empties once it is saved. */
function AddEntry(props: {
  label: string;
  placeholder: string;
  disabled: boolean;
  onAdd(entry: string): Promise<boolean>;
}) {
  const [typed, setTyped] = useState("");
  const entry = typed.trim();
  return (
    <SettingFooter className="justify-start">
      <form
        className="flex min-w-0 flex-1 items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (entry) void props.onAdd(entry).then((saved) => saved && setTyped(""));
        }}
      >
        <Input
          aria-label={props.label}
          placeholder={props.placeholder}
          value={typed}
          className="min-w-0 flex-1"
          disabled={props.disabled}
          onChange={(event) => setTyped(event.target.value)}
        />
        <Button type="submit" size="sm" variant="secondary" disabled={props.disabled || !entry}>
          Add
        </Button>
      </form>
    </SettingFooter>
  );
}
