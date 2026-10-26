import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { SkillAgent, SkillPresence } from "@ace/protocol";
import { honoursManual, skillAgents, type SkillRoot } from "./skill-roots.ts";

/** One `<root>/<name>` entry that contains a SKILL.md, as the filesystem shows it. */
export interface SkillFolder {
  root: SkillRoot;
  name: string;
  /** `<root>/<name>` as written, before resolving links. */
  path: string;
  /** Resolved directory. */
  real: string;
  link: boolean;
  /** Resolved root folder, for containment. */
  rootReal: string;
}
/** One skill directory and everything that refers to it. */
export interface SkillPlace {
  id: string;
  real: string;
  name: string;
  scope: SkillRoot["scope"];
  /** The real (non-link) folder inside a known root, when there is one. */
  canonical: SkillFolder | undefined;
  /** Every folder resolving to `real`: the canonical folder and the links to it. */
  members: SkillFolder[];
  /** Separate folders with the same name in the same scope. */
  copies: SkillFolder[];
}
export const skillId = (real: string) => `skl_${createHash("sha1").update(real).digest("hex")}`;
export function inside(parent: string, child: string): boolean {
  const tail = relative(parent, child);
  return tail !== "" && tail !== ".." && !tail.startsWith(`..${sep}`) && !tail.startsWith(sep);
}
/** A canonical folder only counts when it is a direct, real child of its root. */
function canonicalOf(members: readonly SkillFolder[]): SkillFolder | undefined {
  return members.find((m) => !m.link && m.real === join(m.rootReal, m.name));
}
/** Deduplicate by realpath, then fold same-name folders into the first root's entry as copies. */
export function groupSkills(folders: readonly SkillFolder[]): SkillPlace[] {
  const byReal = new Map<string, SkillFolder[]>();
  for (const folder of folders) {
    const members = byReal.get(folder.real);
    if (members) members.push(folder);
    else byReal.set(folder.real, [folder]);
  }
  const groups = [...byReal.values()].map((members) => {
    const canonical = canonicalOf(members);
    const first = canonical ?? members[0];
    if (!first) throw new Error("skill_group_empty");
    return { canonical, members, name: first.name, scope: first.root.scope, first };
  });
  const places: SkillPlace[] = [];
  const claimed = new Set<(typeof groups)[number]>();
  for (const group of groups) {
    if (claimed.has(group)) continue;
    const copies = groups.filter(
      (other) =>
        other !== group &&
        !claimed.has(other) &&
        other.name === group.name &&
        other.scope === group.scope,
    );
    for (const copy of copies) claimed.add(copy);
    places.push({
      id: skillId(group.first.real),
      real: group.first.real,
      name: group.name,
      scope: group.scope,
      canonical: group.canonical,
      members: group.members,
      copies: copies.flatMap((copy) => copy.members),
    });
  }
  return places;
}
interface Access {
  provider: SkillAgent;
  via: SkillPresence["via"];
  folder: SkillFolder;
}
function access(place: SkillPlace, without: ReadonlySet<SkillFolder> = new Set()): Access[] {
  const out: Access[] = [];
  for (const provider of skillAgents) {
    const reads = (folder: SkillFolder) =>
      !without.has(folder) && folder.root.readers.includes(provider);
    const own = place.members.filter(reads);
    const folder = own.find((m) => !m.link) ?? own[0];
    if (folder) out.push({ provider, via: folder.link ? "link" : "native", folder });
    else {
      const copy = place.copies.find(reads);
      if (copy) out.push({ provider, via: "copy", folder: copy });
    }
  }
  return out;
}
export type KeptReason = "canonical" | "copy" | "shared";
export interface AgentPlan {
  /** Link roots to add `<root>/<name>` links in. */
  add: SkillRoot[];
  remove: SkillFolder[];
  kept: { provider: SkillAgent; reason: KeptReason }[];
  /** Agents with no folder to link from in this scope. */
  unreachable: SkillAgent[];
}
/** What changes give exactly `wanted` agents, never touching real folders or other agents. */
export function planAgents(
  place: SkillPlace,
  roots: readonly SkillRoot[],
  wanted: readonly SkillAgent[],
): AgentPlan {
  const current = access(place);
  const plan: AgentPlan = { add: [], remove: [], kept: [], unreachable: [] };
  const removing = new Set<SkillFolder>();
  for (const now of current) {
    if (wanted.includes(now.provider)) continue;
    if (now.via !== "link") {
      plan.kept.push({ provider: now.provider, reason: now.via === "copy" ? "copy" : "canonical" });
      continue;
    }
    const links = place.members.filter((m) => m.link && m.root.readers.includes(now.provider));
    const next = new Set([...removing, ...links]);
    const after = access(place, next);
    const lost = current.filter((a) => !after.some((b) => b.provider === a.provider));
    if (after.some((a) => a.provider === now.provider))
      plan.kept.push({ provider: now.provider, reason: "canonical" });
    else if (lost.some((a) => wanted.includes(a.provider)))
      plan.kept.push({ provider: now.provider, reason: "shared" });
    else for (const link of links) removing.add(link);
  }
  plan.remove = [...removing];
  for (const provider of wanted) {
    if (current.some((a) => a.provider === provider)) continue;
    const root = roots.find((r) => r.scope === place.scope && r.linkFor.includes(provider));
    if (root) plan.add.push(root);
    else plan.unreachable.push(provider);
  }
  return plan;
}
/** Home as `~`; project skills relative to the project. */
export function displayPath(path: string, home: string, workspace: string | undefined): string {
  if (workspace && inside(workspace, path)) return relative(workspace, path);
  if (inside(home, path)) return `~/${relative(home, path)}`;
  return path;
}
export function presence(
  place: SkillPlace,
  roots: readonly SkillRoot[],
  show: (path: string) => string,
): SkillPresence[] {
  const current = access(place);
  return current.map(({ provider, via, folder }) => ({
    provider,
    via,
    path: show(folder.path),
    removable:
      via === "link" &&
      planAgents(
        place,
        roots,
        current.map((a) => a.provider).filter((p) => p !== provider),
      ).remove.length > 0,
    honoursManual: honoursManual[provider],
  }));
}
