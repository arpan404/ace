import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type ComponentProps } from "react";
import { useLayout } from "@/lib/layout.tsx";
import { newThreadOn } from "@/lib/machine-routes.ts";
import { useMachinesInSpace, type Machine } from "@/lib/machines.ts";
import { OnMachine } from "../on-machine.tsx";
import {
  NewThreadMachineContext,
  rememberMachine,
  rememberedMachine,
  targetMachine,
  type Leaving,
} from "./machine-choice.ts";
import { carryDraft } from "./carried-draft.ts";
import { NewThreadPage } from "./new-thread-page.tsx";

/**
 * New thread on the machine `?machine=` names, else the one picked last (ADR 0102). The whole
 * page runs under that machine's client: its projects, models, branches, access and the create
 * command. The strip's machine picker moves it to another machine.
 */
export function NewThreadOnMachine(
  props: ComponentProps<typeof NewThreadPage> & { machine?: string | undefined },
) {
  const { machine: asked, ...page } = props;
  const { storage } = useLayout();
  // The window's space's machines (ADR 0206 §2.4): in an organization's space its hosts, so a
  // new thread starts on one of them unless the page names another machine.
  const machines = useMachinesInSpace();
  const navigate = useNavigate();
  // Read once: a pool that comes online later doesn't move a page already being written in.
  const [remembered] = useState(() => targetMachine({}, machines, rememberedMachine(storage)));
  const own = machines[0];
  // Without a remembered machine the space's first: this window's own when it is in the space.
  const spaceFirst = own && !own.primary ? own.id : undefined;
  const target = asked ?? (props.project ? undefined : (remembered ?? spaceFirst));
  const current = (target && machines.find((each) => each.id === target)) || own;
  const choice = useMemo(
    () =>
      current && {
        machines,
        current,
        choose(next: Machine, leaving?: Leaving) {
          rememberMachine(storage, next.primary ? undefined : next.id);
          if (leaving) carryDraft(storage, leaving.draft, next.id);
          // Named even for this window's own, so the choice outlasts a remembered default.
          void navigate(newThreadOn(next.id, leaving?.project, leaving?.from));
        },
      },
    [machines, current, storage, navigate],
  );
  return (
    <NewThreadMachineContext value={choice}>
      <OnMachine machine={target} title="New thread" page="new-thread">
        <NewThreadPage {...page} />
      </OnMachine>
    </NewThreadMachineContext>
  );
}
