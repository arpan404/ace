import {
  spadeArrivalLine,
  spadeMoveLine,
  type SpadeArrival,
  type SpadeMove,
} from "@ace/ui-core/spade-chat";
import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { cn } from "@/lib/cn.ts";
import { primaryMachineId, useMachines } from "@/lib/machines.ts";
import { pillButton } from "./spade-profile-parts.tsx";
import { spadeMachineKey, useSpadeClient } from "./spade-machine.tsx";
import { acceptMove, cancelMove, dismissArrival, newMoveId, startMove } from "./spade-move-api.ts";
import { agentsKey, mainKey, type RosterBot } from "./use-spade-roster.ts";

/*
 * Moving a bot to another of the person's machines (ADR 0187, docs/design/spade.md §4): the
 * Machine row offers Move to…, a menu of the other machines that run Spade; the main Spade, read
 * through a machine that isn't its host, offers Move Spade to this machine. While it moves, and
 * after a move failed or the bot arrived, one sentence says so with its text buttons beside it.
 * Words only: no icons, tints or progress bar.
 */

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/** The other machines a bot could move to: online with Spade answering, or named as away. */
function useMoveTargets(bot: RosterBot) {
  const machines = useMachines();
  const cache = useQueryClient();
  return machines
    .filter((machine) => spadeMachineKey(machine) !== bot.machine.key)
    .filter((machine) => machine.id !== primaryMachineId)
    .map((machine) => ({
      id: machine.id,
      name: machine.primary ? "This machine" : machine.name,
      ready:
        machine.client !== undefined &&
        cache.getQueryState([...agentsKey, spadeMachineKey(machine)])?.status === "success",
    }));
}

function useMoveActions(bot: RosterBot) {
  const client = useSpadeClient();
  const here = useClient();
  const machines = useMachines();
  const cache = useQueryClient();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(undefined);
    try {
      await action();
      await cache.invalidateQueries({ queryKey: agentsKey });
      await cache.invalidateQueries({ queryKey: mainKey });
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setBusy(false);
    }
  };
  return {
    problem,
    busy,
    // The person's one click: accepted on the machine it goes to, then started where it is.
    move: (to: string) =>
      run(async () => {
        const machine = machines.find((candidate) => candidate.id === to);
        const target = machine?.primary ? here : machine?.client;
        if (!target) throw new Error("That machine can't be reached now.");
        const id = newMoveId(crypto.randomUUID());
        await acceptMove(target, id, bot.id);
        await startMove(client, bot.id, to, id);
      }),
    cancel: () => run(() => cancelMove(client, bot.id)),
    dismissArrival: () => run(() => dismissArrival(client, bot.id)),
  };
}

/** Details' Machine row: where the bot runs, and Move to… while it isn't moving. */
export function ProfileMachine(props: { bot: RosterBot }) {
  const { bot } = props;
  const targets = useMoveTargets(bot);
  const actions = useMoveActions(bot);
  const here = useMachines().find((machine) => machine.primary);
  const moving = bot.move !== undefined && bot.move.state !== "failed";
  // Spade read through another machine: it can come here in one step.
  const comeHere =
    bot.kind === "main" && !bot.machine.primary && here && here.id !== primaryMachineId;
  const canMove = !moving && !bot.away && !bot.unavailable && targets.length > 0;
  return (
    <>
      <SettingRow
        title="Machine"
        inline
        description={actions.problem && <span className="text-destructive">{actions.problem}</span>}
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-ui text-foreground">{bot.machine.name}</span>
          {canMove && !comeHere && (
            <Menu>
              <MenuTrigger
                aria-label={`Move ${bot.name} to another machine`}
                disabled={actions.busy}
                className={cn(
                  pillButton,
                  "-mr-3.5 text-ui text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                Move to…
              </MenuTrigger>
              <MenuContent align="end">
                {targets.map((target) => (
                  <MenuItem
                    key={target.id}
                    disabled={!target.ready}
                    onClick={() => void actions.move(target.id)}
                  >
                    {target.ready ? target.name : `${target.name} · offline`}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          )}
        </span>
      </SettingRow>
      {comeHere && canMove && (
        <div className="py-1">
          <Button
            variant="ghost"
            className={cn(pillButton, "-ml-3.5")}
            disabled={actions.busy}
            onClick={() => void actions.move(here.id)}
          >
            Move Spade to this machine
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * The bot's move, or what needs the person since it arrived, as one sentence at the top of
 * Details with its text buttons.
 */
export function ProfileMoveLine(props: { bot: RosterBot }) {
  const { bot } = props;
  const actions = useMoveActions(bot);
  if (bot.move) return <MoveSentence bot={bot} move={bot.move} actions={actions} />;
  if (bot.arrived) return <ArrivalSentence arrival={bot.arrived} actions={actions} />;
  return null;
}

type Actions = ReturnType<typeof useMoveActions>;

function Line(props: {
  tone?: "failed";
  text: string;
  children: React.ReactNode;
  problem?: string;
}) {
  return (
    <div role="status" className="flex flex-col gap-1 pb-3">
      <p
        className={cn(
          "text-ui leading-5",
          props.tone === "failed" ? "text-status-failed" : "text-foreground",
        )}
      >
        {props.text}
      </p>
      <div className="-ml-3.5 flex flex-wrap items-center gap-1">{props.children}</div>
      {props.problem && <p className="text-xs text-destructive">{props.problem}</p>}
    </div>
  );
}

function MoveSentence(props: { bot: RosterBot; move: SpadeMove; actions: Actions }) {
  const { bot, move, actions } = props;
  const failed = move.state === "failed";
  return (
    <Line
      text={spadeMoveLine(move, bot.name)}
      {...(failed ? { tone: "failed" as const } : {})}
      {...(actions.problem ? { problem: actions.problem } : {})}
    >
      {move.canCancel && (
        <Button
          variant="ghost"
          className={pillButton}
          disabled={actions.busy}
          onClick={() => void actions.cancel()}
        >
          Cancel
        </Button>
      )}
      {failed && (
        <>
          <Button
            variant="ghost"
            className={pillButton}
            disabled={actions.busy}
            onClick={() => void actions.move(move.to.host)}
          >
            Try again
          </Button>
          <Button
            variant="ghost"
            className={pillButton}
            disabled={actions.busy}
            onClick={() => void actions.cancel()}
          >
            Dismiss
          </Button>
        </>
      )}
    </Line>
  );
}

function ArrivalSentence(props: { arrival: SpadeArrival; actions: Actions }) {
  const { arrival, actions } = props;
  return (
    <Line
      text={spadeArrivalLine(arrival)}
      {...(actions.problem ? { problem: actions.problem } : {})}
    >
      <Button
        variant="ghost"
        className={pillButton}
        disabled={actions.busy}
        onClick={() => void actions.dismissArrival()}
      >
        Dismiss
      </Button>
    </Line>
  );
}
