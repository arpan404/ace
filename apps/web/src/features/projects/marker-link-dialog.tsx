import { WorkspaceId, type ProjectMarker } from "@ace/protocol";
import { displayPath } from "@ace/ui-core";
import { groupProjects, groupMachines } from "@ace/ui-core/project-groups";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useMachines } from "@/lib/machines.ts";
import { usePoolProjects } from "@/lib/pool-projects.ts";
import { Footer, Problem } from "./form-parts.tsx";

/** The same set of remotes: a clone of the same repository rather than a fork of it. */
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((remote) => b.includes(remote));

/**
 * A folder just added carries a project marker (ADR 0181) naming a logical project the
 * person's machines know. The marker only suggests: this asks, naming both sides, with Link as
 * the default. When its remotes differ from every known checkout's it reads as a fork, with Keep
 * linked or New project. New project, or closing, leaves it its own project. A marker naming a
 * project no machine knows asks nothing, unless a machine that knows it connects meanwhile.
 */
export function MarkerLinkDialog(props: {
  projectId: string;
  /** Undefined: this window's own machine. */
  machineId: string | undefined;
  marker: ProjectMarker;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const machines = useMachines();
  const cache = useQueryClient();
  const { lists } = usePoolProjects();
  const machine = machines.find((each) =>
    props.machineId === undefined ? each.primary : each.id === props.machineId,
  );
  const machineId = machine?.id ?? "";
  const added = `${machineId}/${props.projectId}`;
  const known = useMemo(
    () =>
      groupProjects(lists).find(
        (group) =>
          group.identityIds.includes(props.marker.id) &&
          group.checkouts.some((each) => each.key !== added),
      ),
    [lists, props.marker.id, added],
  );
  const elsewhere = (known?.checkouts ?? []).filter((each) => each.key !== added);
  const asked = [
    { machineId, workspaceId: props.projectId },
    ...elsewhere.filter((each) => each.online),
  ];
  const facts = useQueries({
    queries: asked.map((checkout) => {
      const client = machines.find((each) => each.id === checkout.machineId)?.client;
      return {
        queryKey: ["checkoutFacts", `${checkout.machineId}/${checkout.workspaceId}`],
        enabled: client !== undefined,
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
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const { onOpenChange } = props;
  // Nothing known to link to yet (another machine may still be connecting): nothing is asked.
  if (!known) return null;
  const mine = facts[0]?.data;
  const theirs = facts.slice(1).flatMap((result) => (result.data ? [result.data] : []));
  const fork =
    mine !== undefined &&
    mine !== null &&
    mine.remotes.length > 0 &&
    theirs.length > 0 &&
    !theirs.some((each) => sameSet(each.remotes, mine.remotes));
  const thisOne = lists
    .find((list) => list.machineId === machineId)
    ?.projects.find((each) => each.id === props.projectId);
  const here = `${machine?.name ?? "This machine"} · ${displayPath(thisOne?.path ?? "", undefined)}`;
  const link = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await machine?.client?.command({
        type: "workspace.identity.link",
        workspaceId: WorkspaceId.parse(props.projectId),
        identityId: props.marker.id,
        viaMarker: true,
      });
      if (!result?.ok) throw new Error(result?.error ?? "offline");
      void cache.invalidateQueries({ queryKey: ["poolProjects"] });
      onOpenChange(false);
    } catch {
      setProblem(`${machine?.name ?? "The machine"} didn't link it. Try again.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={props.open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{fork ? `Fork of ${known.label}?` : `Link to ${known.label}?`}</DialogTitle>
          <DialogDescription>
            {here} carries the project marker of {known.label}, on {groupMachines(known).join(", ")}
            .{" "}
            {fork
              ? "Its remotes differ from that project's: it may be a fork."
              : "Linked, they show as one project; each keeps its own name, settings and threads."}
          </DialogDescription>
        </DialogHeader>
        <ul aria-label={`${known.label} checkouts`} className="grid gap-1 text-ui">
          {elsewhere.map((checkout) => (
            <li key={checkout.key} className="truncate text-muted-foreground">
              {checkout.machineName} · {displayPath(checkout.path, undefined)}
            </li>
          ))}
        </ul>
        {problem && <Problem>{problem}</Problem>}
        <Footer>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {fork ? "New project" : "Keep separate"}
          </Button>
          <Button variant="primary" autoFocus disabled={busy} onClick={() => void link()}>
            {fork ? "Keep linked" : "Link"}
          </Button>
        </Footer>
      </DialogContent>
    </Dialog>
  );
}
