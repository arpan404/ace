import { describe, expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { decide, host, tree, unplaced, type Operation, type Resource } from "./decide.ts";
import { principal, type Principal } from "./principal.ts";
import { structuralTrees, type TreeAccess, type TreeResolver } from "./trees.ts";

const org = "org_acme";
const t = (id: string) => ThreadId.parse(id);
const mine = t("t_mine");
const minesChild = t("t_mine_child");
const shared = t("t_shared");
const theirs = t("t_theirs");
const bare = t("t_bare");

/** A resolver as the access table will fill it: Ann owns two trees, Bo one private one. */
const access: Record<string, TreeAccess> = {
  [mine]: { owner: "ann", visibility: "private" },
  [shared]: { owner: "ann", visibility: "org" },
  [theirs]: { owner: "bo", visibility: "private" },
};
const filled: TreeResolver = {
  ...structuralTrees((thread) => (thread === minesChild ? mine : undefined)),
  access: (root) => access[root],
};
const partA = structuralTrees(() => undefined);

const member = (account: string, role = "member"): Principal => ({
  kind: "member",
  org,
  account,
  role,
});
const ann = member("ann");
const bo = member("bo");
const orgOwner = member("olu", "owner");
const operator: Principal = { kind: "host" };
const admitted: Principal = { kind: "admitted", org, account: "ann" };
const unproven: Principal = { kind: "unproven" };
const annsAgent: Principal = { kind: "agent", root: mine };
const bosAgent: Principal = { kind: "agent", root: theirs };
const peer = (child: ThreadId): Principal => ({
  kind: "peer",
  capability: { org, from: "host_b", root: t("t_remote_root"), owner: "ann", child },
});

const allowed = (
  who: Principal,
  operation: Operation | undefined,
  resource: Resource,
  trees: TreeResolver = filled,
) => decide(who, operation, resource, trees).allowed;

describe("who a request is on an org host", () => {
  const annM = { org, account: "ann", role: "member" };
  it.each([
    ["a person's machine", { org: undefined, proven: annM, admitted: annM }, "personal"],
    ["an admitted member who proved here", { org, admitted: annM, proven: annM }, "member"],
    ["an admission that never proved", { org, admitted: annM }, "admitted"],
    [
      "a replayed grant: proven as someone else than admitted",
      { org, admitted: annM, proven: { ...annM, account: "bo" } },
      "admitted",
    ],
    [
      "a standing from another organization",
      { org, admitted: annM, proven: { ...annM, org: "org_other" } },
      "admitted",
    ],
    ["the host's token", { org, hostToken: true }, "host"],
    [
      "the host's desktop app once it proves a member",
      { org, hostToken: true, proven: annM },
      "member",
    ],
    ["a proof with no admission and no host token", { org, proven: annM }, "unproven"],
    ["an MCP bearer", { org, agentRoot: mine }, "agent"],
    ["an old paired device", { org }, "unproven"],
  ] as const)("%s", (_, facts, kind) => {
    expect(principal(facts).kind).toBe(kind);
  });
});

describe("decide", () => {
  it("allows everything on a person's machine, so today's checks decide there", () => {
    for (const operation of [undefined, "tree.write", "pairing", "computer"] as const)
      expect(allowed({ kind: "personal" }, operation, unplaced, partA)).toBe(true);
  });

  it("refuses an operation nobody classified, to every principal on an org host", () => {
    for (const who of [ann, orgOwner, operator, annsAgent, admitted])
      expect(allowed(who, undefined, host)).toBe(false);
  });

  it.each<[string, Principal, Operation, Resource, boolean]>([
    // Admission is not identity.
    ["an admission keeps its connection", admitted, "session", host, true],
    ["an admission reaches no Spade", admitted, "spade", host, false],
    ["an admission reads no org tree", admitted, "tree.read", tree({ thread: shared }), false],
    ["an old paired device reads nothing", unproven, "tree.read", tree({ thread: shared }), false],
    // The operator runs the daemon and reads nothing of members'.
    ["the operator runs the daemon", operator, "host.admin", host, true],
    ["the operator reads health", operator, "host.meta", host, true],
    ["the operator reads no tree", operator, "tree.read", tree({ thread: shared }), false],
    ["the operator reaches no Spade", operator, "spade", host, false],
    ["the operator writes into no tree", operator, "tree.write", tree({ thread: mine }), false],
    ["the operator makes no pairing", operator, "pairing", host, false],
    // Members, by visibility; no role reads more.
    ["a member reads an org tree", bo, "tree.read", tree({ thread: shared }), true],
    ["a member reads not another's private tree", bo, "tree.read", tree({ thread: mine }), false],
    ["an org owner reads not a private tree", orgOwner, "tree.read", tree({ thread: mine }), false],
    ["the owner reads their own private tree", ann, "tree.read", tree({ thread: mine }), true],
    ["the owner reads it through a child", ann, "tree.read", tree({ thread: minesChild }), true],
    ["only the owner writes into an org tree", bo, "tree.write", tree({ thread: shared }), false],
    ["the owner writes into their tree", ann, "tree.write", tree({ thread: shared }), true],
    ["an org owner may stop any tree", orgOwner, "tree.stop", tree({ thread: theirs }), true],
    ["a member may not stop another's tree", ann, "tree.stop", tree({ thread: theirs }), false],
    ["a tree with no access row is nobody's", ann, "tree.read", tree({ thread: bare }), false],
    ["a list names no tree", bo, "tree.read", unplaced, false],
    ["an interaction can't be placed yet", ann, "tree.write", tree({ interaction: "i_1" }), false],
    ["members start no tree yet", ann, "tree.create", host, false],
    ["a member reaches Spade", bo, "spade", host, true],
    ["a member runs nothing of the daemon", bo, "host.admin", host, false],
    ["an org owner uses the host's shell", orgOwner, "host.shell", host, true],
    ["a member doesn't", bo, "host.shell", host, false],
    ["computer use is refused even to an org owner", orgOwner, "computer", host, false],
    ["fleet links are refused even to an org owner", orgOwner, "fleet.link", host, false],
    ["transfers are refused", ann, "transfer", tree({ thread: mine }), false],
    // Agents: their own tree, and at most their owner's rights elsewhere.
    ["an agent writes into its own tree", annsAgent, "tree.write", tree({ root: mine }), true],
    ["through a child of it", annsAgent, "tree.write", tree({ thread: minesChild }), true],
    ["an agent reads an org tree", bosAgent, "tree.read", tree({ thread: shared }), true],
    [
      "an agent writes only into its owner's trees",
      bosAgent,
      "tree.write",
      tree({ thread: shared }),
      false,
    ],
    [
      "Ann's agent writes into Ann's other tree",
      annsAgent,
      "tree.write",
      tree({ thread: shared }),
      true,
    ],
    [
      "an agent reads not another's private tree",
      bosAgent,
      "tree.read",
      tree({ thread: mine }),
      false,
    ],
    ["an agent answers no Spade", annsAgent, "spade", host, false],
    ["an agent makes no fleet link", annsAgent, "fleet.link", host, false],
    // Peers: exactly one child.
    ["a peer calls its child", peer(mine), "fleet.child", tree({ thread: mine }), true],
    [
      "a peer's capability refuses another child",
      peer(mine),
      "fleet.child",
      tree({ thread: shared }),
      false,
    ],
    ["a peer reads no tree", peer(mine), "tree.read", tree({ thread: mine }), false],
  ])("%s", (_, who, operation, resource, expected) => {
    expect(allowed(who, operation, resource)).toBe(expected);
  });

  it("refuses every member request on a tree until the access table places it (part A)", () => {
    for (const operation of ["tree.read", "tree.write", "tree.stop"] as const)
      for (const who of [ann, bo, orgOwner])
        expect(allowed(who, operation, tree({ thread: mine }), partA)).toBe(false);
    // Its own tree is still the agent's: the bearer was bound to it when it was minted.
    expect(allowed(annsAgent, "tree.write", tree({ thread: mine }), partA)).toBe(true);
    expect(allowed(annsAgent, "tree.read", tree({ thread: shared }), partA)).toBe(false);
  });
});
