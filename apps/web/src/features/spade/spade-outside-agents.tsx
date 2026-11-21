import {
  readSpadeOutsideAgent,
  readSpadeOutsideAgents,
  type SpadeOutsideAgent,
} from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingAddRow, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { segment, spadeHttp } from "./spade-requests.ts";
import { fault, Refusal } from "./spade-settings-rows.tsx";

/*
 * Settings › Spade › Apps, Outside agents (ADR 0202 §5): A2A agents the person added by address,
 * like an app. Each says whether its card was signed by its publisher's key and which skills
 * Spade's bots may call; every call goes to the person. Add an agent takes its address, and
 * whether it is on the person's own machine or network (only then may Spade reach it at a local
 * address); Spade fetches and checks the card, and refuses one it can't call with why. A task
 * Stop couldn't confirm stopped is named on its agent.
 */

const agentsKey = ["spade", "a2a-agents"] as const;

export function OutsideAgentSettings() {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const toast = useToast();
  const field = useId();
  const localField = useId();
  const listed = useQuery({
    queryKey: [...agentsKey, machine],
    queryFn: async ({ signal }) =>
      readSpadeOutsideAgents(
        JSON.parse(await spadeHttp(client, "GET", "/v1/a2a-agents", { signal })),
      ),
  });
  const [address, setAddress] = useState<string>();
  const [local, setLocal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const refresh = () => cache.invalidateQueries({ queryKey: agentsKey });
  const add = async (typed: string) => {
    setBusy(true);
    setRefusal(undefined);
    try {
      const added = readSpadeOutsideAgent(
        JSON.parse(
          await spadeHttp(client, "POST", "/v1/a2a-agents", {
            body: { address: typed, ...(local ? { local: true } : {}) },
          }),
        ),
      );
      setAddress(undefined);
      setLocal(false);
      if (added) toast.success({ title: `Added ${added.name}`, description: added.signature });
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const remove = async (agent: SpadeOutsideAgent) => {
    try {
      await spadeHttp(client, "DELETE", `/v1/a2a-agents/${segment(agent.id)}`);
    } catch (error) {
      toast.error({ title: `Couldn't remove ${agent.name}`, description: fault(error) });
    }
    await refresh();
  };
  return (
    <SettingSection label="Outside agents" anchor="outside-agents">
      {(listed.data ?? []).map((agent) => (
        <SettingRow
          key={agent.id}
          title={agent.name}
          description={
            <>
              <span title={agent.unsignedBecause}>{agent.signature}</span>
              <span className="block">
                {[
                  agent.skills.map((skill) => skill.name).join(", "),
                  "Each call asks you first",
                  agent.local ? "On your machine or network" : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {agent.unconfirmedStops.length > 0 && (
                <span className="block">
                  {agent.unconfirmedStops.length === 1
                    ? "Spade couldn't confirm a stopped task ended; it may still be running"
                    : `Spade couldn't confirm ${agent.unconfirmedStops.length} stopped tasks ended; they may still be running`}
                </span>
              )}
            </>
          }
          density="compact"
        >
          <Button size="sm" variant="ghost" onClick={() => void remove(agent)}>
            Remove
          </Button>
        </SettingRow>
      ))}
      {address === undefined ? (
        <SettingAddRow onClick={() => setAddress("")}>Add an agent</SettingAddRow>
      ) : (
        <SettingRow
          title="Agent address"
          description={
            refusal ? (
              <Refusal>{refusal}</Refusal>
            ) : (
              "Spade reads its Agent Card there and checks who signed it."
            )
          }
          htmlFor={field}
          density="compact"
        >
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (address.trim()) void add(address.trim());
            }}
          >
            <Input
              id={field}
              value={address}
              placeholder="https://agents.example.com"
              onChange={(event) => setAddress(event.target.value)}
              autoFocus
            />
            <label htmlFor={localField} className="shrink-0 text-ui text-foreground">
              On my own machine or network
            </label>
            <Switch id={localField} checked={local} onCheckedChange={setLocal} />
            <Button size="sm" type="submit" disabled={busy || !address.trim()}>
              Add
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => {
                setAddress(undefined);
                setLocal(false);
              }}
            >
              Cancel
            </Button>
          </form>
        </SettingRow>
      )}
    </SettingSection>
  );
}
