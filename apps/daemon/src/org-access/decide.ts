import { orgAllows } from "@ace/account-grant/org-roles";
import type { Principal } from "./principal.ts";
import type { TreeAccess, TreeRef, TreeResolver } from "./trees.ts";

/*
 * The one access policy (ADR 0209 §4.2): `decide(principal, operation, resource)`, deny by
 * default. An operation it doesn't know, a resource it can't place or a principal it has no rule
 * for is refused. Pure: where trees sit is read through the injected resolver.
 */

/** Every operation the policy knows. Anything a transport can't name as one of these is refused. */
export type Operation =
  /** Keeping the connection: hello, ping, proving standing, refreshing a grant. */
  | "session"
  /** The daemon's own state, without member content: health, versions, updates. */
  | "host.meta"
  /** Running the daemon: its settings, provider sign-ins, machine code, packages. */
  | "host.admin"
  /** The host's shell: its terminal and files outside trees (ADR 0206 §2.2 `host:shell`). */
  | "host.shell"
  /** Spade, where shared bots live; Spade checks each member's stamp itself (ADR 0206 §2.3). */
  | "spade"
  /** Reading a tree: its threads, transcript, diff, attachments, previews and fan-out. */
  | "tree.read"
  /** Anything that changes what a tree executes (§5.2): the owner's alone. */
  | "tree.write"
  /** Halting a tree without reading it (§5.2, §5.5). */
  | "tree.stop"
  /** Starting a new tree on the host (§10, "Who may start a tree"). */
  | "tree.create"
  /** A call into a child this host runs for another host of the organization (§6.2). */
  | "fleet.child"
  /** Fleet links, the machine tunnel and parcels between machines. */
  | "fleet.link"
  /** Moving a tree to or from another machine. */
  | "transfer"
  /** Making or redeeming a pairing link. */
  | "pairing"
  /** Computer use and simulators, refused for coding trees on org hosts (§10). */
  | "computer";

export type Resource = { kind: "host" } | { kind: "tree"; ref: TreeRef } | { kind: "unplaced" };

export const host: Resource = { kind: "host" };
export const unplaced: Resource = { kind: "unplaced" };
export const tree = (ref: TreeRef): Resource => ({ kind: "tree", ref });

export type Decision = { allowed: true } | { allowed: false; reason: string };

const allow: Decision = { allowed: true };
const deny = (reason: string): Decision => ({ allowed: false, reason });

/** Who may read a tree with this access (§5.1). No role reads more. */
const reads = (account: string, access: TreeAccess) =>
  access.owner === account ||
  access.visibility === "org" ||
  (access.visibility === "members" && access.readers?.includes(account) === true);

/** What a member may do to a placed tree. */
function memberOnTree(
  operation: Operation,
  account: string,
  role: string,
  access: TreeAccess,
): Decision {
  switch (operation) {
    case "tree.read":
      return reads(account, access) ? allow : deny("not_shared");
    case "tree.write":
      return access.owner === account ? allow : deny("not_owner");
    case "tree.stop":
      // Owners of the organization may stop any tree without reading it (§5.5).
      return access.owner === account || orgAllows(role, "host:shell") ? allow : deny("not_owner");
    default:
      return deny("unclassified");
  }
}

const treeOperations: ReadonlySet<Operation> = new Set(["tree.read", "tree.write", "tree.stop"]);

/**
 * Whether `principal` may do `operation` on `resource`, on this host. On a person's machine it
 * always allows: today's checks decide there, unchanged.
 */
export function decide(
  principal: Principal,
  operation: Operation | undefined,
  resource: Resource,
  trees: TreeResolver,
): Decision {
  if (principal.kind === "personal") return allow;
  if (operation === undefined) return deny("unclassified");
  if (operation === "session") return allow;
  switch (principal.kind) {
    case "unproven":
    case "admitted":
      return deny("unproven");
    case "host":
      // The operator runs the daemon; it never reads or writes member content (§3).
      return operation === "host.meta" || operation === "host.admin" || operation === "host.shell"
        ? allow
        : deny("operator");
    case "member": {
      if (operation === "spade") return allow;
      if (operation === "host.meta" || operation === "host.admin" || operation === "host.shell")
        return orgAllows(principal.role, "host:shell") ? allow : deny("not_org_owner");
      if (!treeOperations.has(operation)) return deny("refused_on_org_host");
      if (resource.kind !== "tree") return deny("unplaced");
      const root = trees.root(resource.ref);
      const access = root === undefined ? undefined : trees.access(root);
      if (!access) return deny("unplaced");
      return memberOnTree(operation, principal.account, principal.role, access);
    }
    case "agent": {
      // What the daemon offers every thread alike: models, the host's shared projects.
      if (operation === "host.meta") return allow;
      if (!treeOperations.has(operation)) return deny("refused_on_org_host");
      if (resource.kind !== "tree") return deny("unplaced");
      const root = trees.root(resource.ref);
      if (root === undefined) return deny("unplaced");
      // Its own tree, the one its bearer was minted for: bound, never re-derived.
      if (root === principal.root) return allow;
      // Another tree: at most its owner's rights, and writes only into the owner's own trees.
      const own = trees.access(principal.root);
      const access = trees.access(root);
      if (!own || !access) return deny("unplaced");
      if (operation === "tree.read") return reads(own.owner, access) ? allow : deny("not_shared");
      return access.owner === own.owner ? allow : deny("not_owner");
    }
    case "peer": {
      // Exactly the one child its capability names, never another of that tree (§6.2).
      if (operation !== "fleet.child" || resource.kind !== "tree")
        return deny("refused_on_org_host");
      const { ref } = resource;
      const target = "thread" in ref ? ref.thread : "root" in ref ? ref.root : undefined;
      return target === principal.capability.child ? allow : deny("other_child");
    }
  }
}
