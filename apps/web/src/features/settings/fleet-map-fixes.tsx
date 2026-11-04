import { useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { MachineCodePrompt } from "@/features/ace-account/index.ts";
import { useMachinePool } from "@/lib/machine-pool.ts";
import type { Machine } from "@/lib/machines.ts";
import type { FleetDevice } from "./data/fleet-links.ts";
import type { MapFix, MapNode } from "./data/fleet-map-types.ts";
import { settingKeys } from "./data/setting-keys.ts";
import type { FleetMapData } from "./data/use-fleet-map.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { useRemoveDevice } from "./fleet-devices.tsx";
import type { AccountOpenings } from "./fleet-map-openings.ts";
import { useRemoveMachine } from "./machine-devices.tsx";
import { useMachineAction } from "./machine-unlock.tsx";

/*
 * The Fleet map's fix buttons, each running the flow the rest of Fleet runs for it: the machine
 * code prompt, the network settings, reconnecting, removing or forgetting, and what signing in
 * on a paired device gives. The first is the primary one.
 */

const words: Record<MapFix, string> = {
  enterCode: "Enter code",
  openAccount: "Try again",
  turnOnLan: "Turn on local network",
  turnOnRemote: "Turn on remote access",
  reconnect: "Try again",
  removeMachine: "Remove",
  forgetMachine: "Forget",
  removeDevice: "Remove",
  askSignIn: "Ask it to sign in",
};

function FixButton(props: {
  fix: MapFix;
  first: boolean;
  disabled?: boolean | undefined;
  label?: string | undefined;
  onClick(): void;
}) {
  return (
    <Button
      size="sm"
      variant={props.first ? "primary" : "secondary"}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label ?? words[props.fix]}
    </Button>
  );
}

function Row(props: { children: ReactNode; after?: ReactNode }) {
  return (
    <>
      <div className="mt-2.5 flex flex-wrap gap-2">{props.children}</div>
      {props.after}
    </>
  );
}

/** Turning a network setting on, on this computer. */
function SettingFix(props: { fix: "turnOnLan" | "turnOnRemote"; first: boolean }) {
  const control = useSettingControl(
    props.fix === "turnOnLan" ? settingKeys.remoteLan : settingKeys.remoteEnabled,
    props.fix === "turnOnLan" ? "Local network" : "Remote access",
  );
  return (
    <FixButton
      fix={props.fix}
      first={props.first}
      disabled={!control.loaded || control.offline || control.pending || control.value}
      onClick={() => void control.set(true)}
    />
  );
}

/** What signing in on a paired device gives, said once asked. */
function SignInFix(props: { name: string; first: boolean }) {
  const [shown, setShown] = useState(false);
  return shown ? (
    <p role="status" className="basis-full text-xs leading-5 text-muted-foreground">
      Open app.acehq.dev on {props.name} and sign in with your ace account. It then reaches every
      machine from anywhere, with no code.
    </p>
  ) : (
    <FixButton fix="askSignIn" first={props.first} onClick={() => setShown(true)} />
  );
}

function MachineFixes(props: { node: MapNode; machine: Machine; data: FleetMapData }) {
  const { machine } = props;
  const pool = useMachinePool();
  const action = useMachineAction(machine);
  const remove = useRemoveMachine(machine, props.data.fleet);
  const fixes = props.node.problem?.fixes ?? [];
  return (
    <Row after={<div className="mt-2.5 empty:hidden">{action.prompt}</div>}>
      {fixes.map((fix, index) =>
        fix === "enterCode" ? (
          <FixButton
            key={fix}
            fix={fix}
            first={index === 0}
            disabled={!action.canUnlock}
            onClick={action.unlock}
          />
        ) : fix === "reconnect" ? (
          <FixButton
            key={fix}
            fix={fix}
            first={index === 0}
            onClick={() => pool?.reconnect(machine.id)}
          />
        ) : fix === "removeMachine" ? (
          <FixButton
            key={fix}
            fix={fix}
            first={index === 0}
            disabled={remove.pending}
            onClick={remove.ask}
          />
        ) : null,
      )}
      {remove.dialog}
    </Row>
  );
}

function AccountFixes(props: { node: MapNode; data: FleetMapData; openings: AccountOpenings }) {
  const { node, openings } = props;
  const machine = props.data.account.only.find((entry) => entry.hostId === node.id);
  const connection = openings.connection(node.id);
  const [asking, setAsking] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>();
  const toast = useToast();
  if (!machine) return null;
  const fixes = node.problem?.fixes ?? (node.offer ? [node.offer] : []);
  const state = openings.state(node.id);
  const prompt = connection && state?.kind === "asking" && asking && (
    <div className="mt-2.5">
      <MachineCodePrompt
        gate={connection.gate}
        machine={machine.name}
        lockedUntil={state.lockedUntil}
        onEntered={() => connection.retry()}
      />
    </div>
  );
  return (
    <Row after={prompt}>
      {fixes.map((fix, index) =>
        fix === "enterCode" ? (
          !asking && (
            <FixButton key={fix} fix={fix} first={index === 0} onClick={() => setAsking(true)} />
          )
        ) : fix === "openAccount" ? (
          <FixButton
            key={fix}
            fix={fix}
            first={index === 0}
            label={node.problem ? undefined : "Open"}
            disabled={!openings.available || openings.openings.get(node.id)?.kind === "connecting"}
            onClick={() => openings.open(machine)}
          />
        ) : fix === "forgetMachine" ? (
          <FixButton
            key={fix}
            fix={fix}
            first={index === 0}
            disabled={props.data.account.forget.isPending}
            onClick={() =>
              setConfirming({
                title: `Forget ${machine.name}?`,
                body: "It leaves your ace account's machines until it signs in to the account again.",
                confirm: "Forget",
                run: () =>
                  void props.data.account.forget
                    .mutateAsync(machine.hostId)
                    .catch((error: unknown) =>
                      toast.error({
                        title: "Couldn't forget it",
                        description: error instanceof Error ? error.message : undefined,
                      }),
                    ),
              })
            }
          />
        ) : null,
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </Row>
  );
}

function DeviceFixes(props: { node: MapNode; device: FleetDevice; data: FleetMapData }) {
  const remove = useRemoveDevice(props.data.fleet);
  const fixes = props.node.problem?.fixes ?? [];
  return (
    <Row>
      {fixes.map((fix, index) =>
        fix === "removeDevice" ? (
          <FixButton
            key={fix}
            fix={fix}
            first={index === 0}
            disabled={remove.pending}
            onClick={() => remove.ask(props.device)}
          />
        ) : fix === "turnOnLan" || fix === "turnOnRemote" ? (
          <SettingFix key={fix} fix={fix} first={index === 0} />
        ) : fix === "askSignIn" ? (
          <SignInFix key={fix} name={props.node.name} first={index === 0} />
        ) : null,
      )}
      {remove.dialog}
    </Row>
  );
}

/** The fixes for one node, by what it is. */
export function MapFixes(props: { node: MapNode; data: FleetMapData; openings: AccountOpenings }) {
  const { node, data } = props;
  if (node.role === "machine") {
    const machine = data.fleet.byId(node.id);
    return machine ? <MachineFixes node={node} machine={machine} data={data} /> : null;
  }
  if (node.role === "account")
    return <AccountFixes node={node} data={data} openings={props.openings} />;
  if (node.role === "device") {
    const device = data.fleet.joined.find((entry) => `device:${entry.key}` === node.id);
    return device ? <DeviceFixes node={node} device={device} data={data} /> : null;
  }
  return (
    <Row>
      {(node.problem?.fixes ?? []).map((fix, index) =>
        fix === "turnOnLan" || fix === "turnOnRemote" ? (
          <SettingFix key={fix} fix={fix} first={index === 0} />
        ) : null,
      )}
    </Row>
  );
}
