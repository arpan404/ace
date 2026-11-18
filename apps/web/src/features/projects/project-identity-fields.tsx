import type { ClientApi } from "@ace/client";
import {
  WorkspaceId,
  type ProjectCheckoutFacts,
  type ProjectIdentitySuggestion,
} from "@ace/protocol";
import { displayPath } from "@ace/ui-core";
import { groupOf, groupProjects, type ProjectCheckout } from "@ace/ui-core/project-groups";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { listDivider } from "@/components/ui/rules.ts";
import { useMachines, useScopedMachine } from "@/lib/machines.ts";
import { usePoolProjects } from "@/lib/pool-projects.ts";
import {
  keepsIdentities,
  linkPlan,
  markerLinkPlan,
  runLinkPlan,
  type CheckoutRef,
  type LinkPlan,
} from "./identity-link.ts";

/** The most suggestion pages read from one machine each time they are asked for. */
const pagesPerMachine = 8;

interface Suggestion extends ProjectIdentitySuggestion {
  machineId: string;
  machineName: string;
  path: string;
  name: string;
}

async function checkoutOf(client: ClientApi, workspaceId: string) {
  const reply = await client.request({
    type: "workspace.request",
    operation: { op: "workspace.checkout", workspaceId },
  });
  if (reply.result.kind !== "checkout") throw new Error("unsupported");
  return reply.result.checkout;
}

/** Registrations on one machine that may be the same project: bounded pages, in order. */
async function suggestionsOn(
  client: ClientApi,
  facts: ProjectCheckoutFacts,
  identityId: string | undefined,
) {
  const found: ProjectIdentitySuggestion[] = [];
  let after: string | undefined;
  for (let page = 0; page < pagesPerMachine; page++) {
    const reply = await client.request({
      type: "workspace.request",
      operation: {
        op: "workspaces.identitySuggestions",
        remotes: facts.remotes,
        subpath: facts.subpath,
        // Also folders whose project marker names this one (ADR 0181).
        ...(identityId ? { identityId } : {}),
        limit: 32,
        ...(after ? { after } : {}),
      },
    });
    if (reply.result.kind !== "identitySuggestions") return found;
    found.push(...reply.result.suggestions);
    if (!reply.result.next) return found;
    after = reply.result.next;
  }
  return found;
}

const where = (checkout: { machineName: string; path: string }) =>
  `${checkout.machineName} · ${displayPath(checkout.path, undefined)}`;

/**
 * "Same project elsewhere" in Edit project (ADR 0180): this checkout's logical project on the
 * person's other machines and here. Linked checkouts can be split off one at a time. Others that
 * may be the same (a shared remote at the same folder inside it) are found only when asked, and
 * nothing links until the person confirms a link naming both sides. A machine older than
 * identity is left out; on one, the section isn't shown at all.
 */
export function ProjectIdentityFields(props: {
  projectId: string;
  /** This checkout's folder, named in the link confirmation. */
  path: string;
  /** New logical project ids; `crypto.randomUUID` unless a test injects one. */
  newId?: () => string;
}) {
  const machines = useMachines();
  const scoped = useScopedMachine();
  const here = scoped ?? machines.find((each) => each.primary);
  const cache = useQueryClient();
  const { lists } = usePoolProjects();
  const groups = useMemo(() => groupProjects(lists), [lists]);
  const online = machines.filter((each) => each.status === "online" && each.client);
  const capable = useQueries({
    queries: online.map((machine) => ({
      queryKey: ["keepsIdentities", machine.id] as const,
      staleTime: 300_000,
      queryFn: () => (machine.client ? keepsIdentities(machine.client) : false),
    })),
  });
  const keeping = online.filter((_, index) => capable[index]?.data === true);
  const facts = useQuery({
    queryKey: ["checkoutFacts", `${here?.id}/${props.projectId}`],
    enabled: here?.client !== undefined,
    staleTime: 60_000,
    retry: false,
    queryFn: () => (here?.client ? checkoutOf(here.client, props.projectId) : null),
  });
  const [searching, setSearching] = useState(false);
  const [confirming, setConfirming] = useState<Suggestion>();
  const [busy, setBusy] = useState(false);
  const [half, setHalf] = useState<{ plan: LinkPlan; failed: string[] }>();
  const [problem, setProblem] = useState<string>();
  const [sharing, setSharing] = useState<"conflict" | "unreadable" | "written">();
  const group = here ? groupOf(groups, here.id, props.projectId) : undefined;
  const others = (group?.checkouts ?? []).filter(
    (each) => !(each.machineId === here?.id && each.workspaceId === props.projectId),
  );
  const ownIdentity = group?.checkouts.find(
    (each) => each.machineId === here?.id && each.workspaceId === props.projectId,
  )?.identityId;
  const found = useQueries({
    queries: keeping.map((machine) => ({
      queryKey: [
        "identitySuggestions",
        machine.id,
        facts.data?.remotes,
        facts.data?.subpath,
        ownIdentity,
      ],
      enabled: searching && Boolean(facts.data?.remotes.length || ownIdentity),
      staleTime: 30_000,
      queryFn: () =>
        machine.client && facts.data ? suggestionsOn(machine.client, facts.data, ownIdentity) : [],
    })),
  });
  const inGroup = new Set((group?.checkouts ?? []).map((each) => each.key));
  const suggestions: Suggestion[] = keeping.flatMap((machine, index) =>
    (found[index]?.data ?? []).flatMap((suggestion) => {
      const key = `${machine.id}/${suggestion.workspaceId}`;
      if (
        inGroup.has(key) ||
        (machine.id === here?.id && suggestion.workspaceId === props.projectId)
      )
        return [];
      const listed = lists
        .find((list) => list.machineId === machine.id)
        ?.projects.find((each) => each.id === suggestion.workspaceId);
      return listed
        ? [{ ...suggestion, machineId: machine.id, machineName: machine.name, ...listed }]
        : [];
    }),
  );
  const searchingNow = searching && found.some((result) => result.isFetching);
  const clientOf = (machineId: string) => machines.find((each) => each.id === machineId)?.client;
  const refresh = () => void cache.invalidateQueries({ queryKey: ["poolProjects"] });

  // An older daemon here keeps no identities: nothing to show.
  if (!here || facts.isError || (facts.isSuccess && facts.data === null)) return null;

  const run = async (plan: LinkPlan) => {
    setBusy(true);
    setProblem(undefined);
    try {
      const failed = await runLinkPlan(plan, clientOf);
      setHalf(failed.length ? { plan, failed } : undefined);
      if (!failed.length) setConfirming(undefined);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const link = (suggestion: Suggestion) => {
    const a: CheckoutRef = { machineId: here.id, workspaceId: props.projectId };
    const b: CheckoutRef = { machineId: suggestion.machineId, workspaceId: suggestion.workspaceId };
    const newId = props.newId ?? (() => crypto.randomUUID());
    // Only its marker says so: that checkout alone joins, and it is never a transfer's landing.
    const plan =
      suggestion.marker && suggestion.shared.length === 0
        ? markerLinkPlan(groups, a, b, newId)
        : linkPlan(
            groups,
            a,
            b,
            keeping.map((each) => each.id),
            newId,
          );
    void run(plan);
  };
  const unlink = async (checkout: ProjectCheckout) => {
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await clientOf(checkout.machineId)?.command({
        type: "workspace.identity.unlink",
        workspaceId: WorkspaceId.parse(checkout.workspaceId),
      });
      if (!result?.ok) setProblem(`${checkout.machineName} didn't unlink it. Try again.`);
    } catch {
      setProblem(`${checkout.machineName} didn't answer. Try again.`);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  /** "Share identity with clones" (ADR 0181): write the marker, asking before replacing one. */
  const share = async (replace: boolean) => {
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await here.client?.command({
        type: "workspace.identity.marker.write",
        workspaceId: WorkspaceId.parse(props.projectId),
        ...(replace ? { replace: true as const } : {}),
      });
      if (result?.error === "marker_conflict") setSharing("conflict");
      else if (result?.error === "marker_unreadable") setSharing("unreadable");
      else if (result?.ok) setSharing("written");
      else setProblem("Couldn't write the project marker. Is the folder read-only?");
    } catch {
      setProblem(`${here.name} didn't answer. Try again.`);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const canChange = (machineId: string) => keeping.some((each) => each.id === machineId);
  const thisOne = { machineName: here.name, path: props.path };

  return (
    <div role="group" aria-label="Same project elsewhere" className="grid gap-1.5">
      <h3 className="text-sm font-medium text-muted-foreground">Same project elsewhere</h3>
      {others.length > 0 ? (
        <ul className={listDivider}>
          {others.map((checkout) => (
            <li
              key={checkout.key}
              aria-label={where(checkout)}
              className="flex items-center gap-2.5 py-2"
            >
              <div className="grid min-w-0 flex-1">
                <span className="truncate text-ui">{where(checkout)}</span>
                <span className="text-meta text-subtle-foreground">
                  {[checkout.name, checkout.online ? undefined : "Offline"]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              {checkout.online && canChange(checkout.machineId) && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Unlink: ${where(checkout)}`}
                  onClick={() => void unlink(checkout)}
                >
                  Unlink
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ui text-muted-foreground">
          Not linked to a checkout on another machine.
        </p>
      )}
      {half && (
        <div role="alert" className="flex items-center gap-2 text-sm text-status-needs">
          <span className="flex-1">
            Half linked:{" "}
            {half.failed
              .map((id) => machines.find((each) => each.id === id)?.name ?? id)
              .join(", ")}{" "}
            didn't take the link yet.
          </span>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void run(half.plan)}>
            Retry
          </Button>
        </div>
      )}
      {confirming ? (
        <div role="group" aria-label="Confirm link" className="grid gap-2 rounded-md border p-3">
          <p className="text-ui">
            Link {where(thisOne)} with {where(confirming)}? They show as one project; each keeps its
            own name, settings and threads.
          </p>
          {!confirming.sameRemotes && confirming.shared.length > 0 && (
            <p className="text-meta text-muted-foreground">
              It has other remotes too: it may be a fork of this project.
            </p>
          )}
          {confirming.shared.length === 0 && (
            <p className="text-meta text-muted-foreground">
              Only its project marker says so, and anyone can copy one. Link it only if it is this
              project.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirming(undefined)}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => link(confirming)}>
              {busy ? "Linking…" : "Link"}
            </Button>
          </div>
        </div>
      ) : searching ? (
        suggestions.length > 0 ? (
          <ul aria-label="Suggestions" className={listDivider}>
            {suggestions.map((suggestion) => (
              <li
                key={`${suggestion.machineId}/${suggestion.workspaceId}`}
                aria-label={where(suggestion)}
                className="flex items-center gap-2.5 py-2"
              >
                <div className="grid min-w-0 flex-1">
                  <span className="truncate text-ui">{where(suggestion)}</span>
                  <span className="text-meta text-subtle-foreground">
                    {[
                      suggestion.shared.length === 0
                        ? undefined
                        : suggestion.sameRemotes
                          ? `Same repository: ${suggestion.shared[0]}`
                          : `Fork of ${suggestion.shared[0]}`,
                      suggestion.marker ? "Its project marker names this project" : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Link: ${where(suggestion)}`}
                  onClick={() => setConfirming(suggestion)}
                >
                  Link…
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ui text-muted-foreground">
            {searchingNow
              ? "Looking on your machines…"
              : facts.data?.remotes.length
                ? "No checkout of the same repository folder found."
                : "This folder has no remote to match by."}
          </p>
        )
      ) : (
        <div className="flex flex-wrap gap-1">
          <Button size="xs" variant="ghost" onClick={() => setSearching(true)}>
            Find it on your machines
          </Button>
          {canChange(here.id) && (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void share(false)}>
              Share identity with clones
            </Button>
          )}
        </div>
      )}
      {(sharing === "conflict" || sharing === "unreadable") && (
        <div role="group" aria-label="Replace marker" className="grid gap-2 rounded-md border p-3">
          <p className="text-ui">
            {sharing === "conflict"
              ? "This folder already has a project marker naming another project. Replace it with this one?"
              : "This folder already has a .ace/project.json that isn't a project marker ace can read. Replace it?"}
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSharing(undefined)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void share(true)}>
              Replace
            </Button>
          </div>
        </div>
      )}
      {sharing === "written" && (
        <p role="status" className="text-meta text-muted-foreground">
          Wrote .ace/project.json. ace never commits it: commit it to share this project with
          clones.
        </p>
      )}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
