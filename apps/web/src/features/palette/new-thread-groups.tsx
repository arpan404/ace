import { ChatCircleIcon, FolderPlusIcon, FolderSimpleIcon } from "@ace/icons";
import { displayPath, projectBadge } from "@ace/ui-core";
import {
  checkoutOrder,
  defaultCheckout,
  groupMachines,
  groupProjects,
  type ProjectCheckout,
  type ProjectGroup,
} from "@ace/ui-core/project-groups";
import { useQueries } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { ProjectMark } from "@/components/project-mark.tsx";
import { CommandChoices, type CommandChoice } from "@/components/ui/command-choices.tsx";
import { CommandShortcut } from "@/components/ui/command.tsx";
import { usePhone } from "@/lib/breakpoints.ts";
import { chatChoice } from "@/lib/chat-choice.ts";
import { useKeys } from "@/lib/keybindings.ts";
import { describeKeys } from "@/lib/keymap.ts";
import type { Machine } from "@/lib/machines.ts";
import { usePoolProjects } from "@/lib/pool-projects.ts";

/** The last row: add a project on this window's machine. */
export const addProjectChoice = "\u0000add-project";

/** Where a chosen logical project starts: the checkout, by machine and project id. */
export interface ChosenCheckout {
  machineId: string;
  workspaceId: string;
}

/**
 * "New thread in…" across every machine (ADR 0180): one row per logical project, named as
 * `groupProjects` names it, with the other names and the machines it is on beside it. A project
 * every machine of which is offline is listed but can't be chosen. Choosing one with several
 * checkouts that can be picked asks which; with one, it opens there at once.
 */
export function NewThreadGroups(props: {
  machines: readonly Machine[];
  chip: ReactNode;
  onBack(): void;
  onSwitchMachines?: (() => void) | undefined;
  /** No project (`chatChoice`) or Add project (`addProjectChoice`), on this window's machine. */
  onChooseOther(choice: string): void;
  onChooseCheckout(checkout: ChosenCheckout): void;
}) {
  const { lists, loaded } = usePoolProjects();
  const groups = useMemo(() => groupProjects(lists), [lists]);
  // By key, so the step follows the live lists: a machine that goes offline reads so at once.
  const [pickingKey, setPicking] = useState<string | undefined>();
  const picking = groups.find((group) => group.key === pickingKey);
  const phone = usePhone();
  const addProjectKeys = useKeys("addProject");
  const choices = useMemo(
    () => [
      { id: chatChoice, label: "No project", icon: ChatCircleIcon },
      ...groups.map((group) => groupChoice(group)),
      {
        id: addProjectChoice,
        label: "Add project",
        icon: FolderPlusIcon,
        separatorBefore: true,
        aside: phone ? undefined : (
          <CommandShortcut>{describeKeys(addProjectKeys)}</CommandShortcut>
        ),
      },
    ],
    [groups, phone, addProjectKeys],
  );
  if (picking)
    return (
      <CheckoutStep
        group={picking}
        machines={props.machines}
        onBack={() => setPicking(undefined)}
        onChoose={props.onChooseCheckout}
      />
    );
  return (
    <CommandChoices
      fieldLabel="Search projects"
      listLabel="Projects"
      placeholder="New thread in…"
      choices={choices}
      onChoose={(choice) => {
        const group = groups.find((each) => each.key === choice.id);
        if (!group) return props.onChooseOther(choice.id);
        const selectable = group.checkouts.filter((each) => each.online);
        const only = selectable.length === 1 ? selectable[0] : undefined;
        if (only) return props.onChooseCheckout(only);
        if (selectable.length > 1) setPicking(group.key);
      }}
      onBack={props.onBack}
      empty={loaded ? "No projects match" : "Reading projects…"}
      trailing={props.chip}
      onSwitchMachines={props.onSwitchMachines}
      switchLabel="Machine"
    />
  );
}

function groupChoice(group: ProjectGroup): CommandChoice {
  const first = group.checkouts[0];
  const machineNames = groupMachines(group);
  const detail = [...group.otherNames, ...machineNames].join(" · ");
  return {
    id: group.key,
    label: group.label,
    icon: FolderSimpleIcon,
    ...(first
      ? {
          mark: (
            <ProjectMark
              id={first.workspaceId}
              badge={projectBadge({ id: first.workspaceId, name: group.label })}
            />
          ),
        }
      : {}),
    detail,
    // Spoken with its machines and other names: two projects of one name sound different.
    spoken: [group.label, detail, ...(group.offline ? ["Offline"] : [])].filter(Boolean).join(", "),
    ...(group.offline
      ? {
          disabled: true,
          aside: <span className="text-xs text-muted-foreground">Offline</span>,
        }
      : {}),
  };
}

/** The repository a checkout is of and its folder inside it, read when the step opens. */
function useCheckoutFacts(checkouts: readonly ProjectCheckout[], machines: readonly Machine[]) {
  const results = useQueries({
    queries: checkouts.map((checkout) => {
      const client = machines.find((each) => each.id === checkout.machineId)?.client;
      return {
        queryKey: ["checkoutFacts", checkout.key] as const,
        enabled: checkout.online && client !== undefined,
        staleTime: 60_000,
        queryFn: async () => {
          if (!client) return null;
          const reply = await client.request({
            type: "workspace.request",
            operation: { op: "workspace.checkout", workspaceId: checkout.workspaceId },
          });
          return reply.result.kind === "checkout" ? reply.result.checkout : null;
        },
      };
    }),
  });
  return results.map((result) => result.data ?? undefined);
}

/**
 * Which checkout of a logical project to start in: machine and path, with its folder inside the
 * repository and the repository once read. Its default comes first (each machine's most
 * recently used, this machine's ahead); offline ones are listed, marked, and can't be chosen.
 */
function CheckoutStep(props: {
  group: ProjectGroup;
  machines: readonly Machine[];
  onBack(): void;
  onChoose(checkout: ChosenCheckout): void;
}) {
  const first = defaultCheckout(props.group);
  const ordered = useMemo(
    () =>
      [...props.group.checkouts].toSorted(
        (a, b) =>
          Number(b.key === first?.key) - Number(a.key === first?.key) || checkoutOrder(a, b),
      ),
    [props.group, first?.key],
  );
  const facts = useCheckoutFacts(ordered, props.machines);
  const choices = ordered.map((checkout, index): CommandChoice => {
    const known = facts[index];
    const where = [
      known?.subpath ? `in ${known.subpath}` : undefined,
      known?.remotes[0],
      checkout.name === props.group.label ? undefined : checkout.name,
    ].filter(Boolean);
    const label = `${checkout.machineName} · ${displayPath(checkout.path, undefined)}`;
    return {
      id: checkout.key,
      label,
      icon: FolderSimpleIcon,
      ...(where.length ? { detail: where.join(" · ") } : {}),
      ...(checkout.online
        ? {}
        : {
            disabled: true,
            spoken: `${label}, Offline`,
            aside: <span className="text-xs text-muted-foreground">Offline</span>,
          }),
    };
  });
  return (
    <CommandChoices
      fieldLabel="Search checkouts"
      listLabel="Checkouts"
      placeholder={`${props.group.label} on…`}
      choices={choices}
      onChoose={(choice) => {
        const checkout = ordered.find((each) => each.key === choice.id);
        if (checkout?.online)
          props.onChoose({ machineId: checkout.machineId, workspaceId: checkout.workspaceId });
      }}
      onBack={props.onBack}
      empty="No checkouts match"
    />
  );
}
