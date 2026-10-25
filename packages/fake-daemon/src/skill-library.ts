import type {
  SkillAgent,
  SkillEntry,
  SkillOperation,
  SkillPresence,
  SkillResult,
  SkillScope,
  SkillSource,
  SkillUsage,
} from "@ace/protocol";

/** One skill folder as a fixture describes it. `agents` lists who sees it and how. */
export interface SkillSeed {
  name: string;
  description: string;
  body: string;
  scope: SkillScope;
  /** Project skills belong to one workspace. */
  workspaceId?: string;
  /** Agent folder this skill lives in; defaults to `.agents/skills`. */
  home?: "agents" | "claude" | "codex";
  links?: readonly SkillAgent[];
  copies?: readonly SkillAgent[];
  manual?: boolean;
  argumentHint?: string;
  source?: SkillSource;
  usage?: Omit<SkillUsage, "id">;
}
const honours: Record<SkillAgent, boolean> = {
  claude: true,
  codex: false,
  opencode: false,
  cursor: true,
  pi: true,
};
/** Which agents read each canonical folder (ADR 0103). */
const readers: Record<NonNullable<SkillSeed["home"]>, readonly SkillAgent[]> = {
  agents: ["codex", "opencode", "cursor", "pi"],
  claude: ["claude", "opencode", "cursor"],
  codex: ["codex", "cursor"],
};
const own: Record<SkillAgent, string> = {
  claude: ".claude/skills",
  codex: ".agents/skills",
  opencode: ".config/opencode/skills",
  cursor: ".cursor/skills",
  pi: ".pi/agent/skills",
};
const order: readonly SkillAgent[] = ["claude", "codex", "opencode", "cursor", "pi"];
const body = (name: string, paragraphs: string) =>
  `# ${name}\n\n${paragraphs}\n\n## Steps\n\n1. Read the request and the files it names.\n2. Do the work in small, checked steps.\n3. Report what changed and what is left.\n`;
const defaults: SkillSeed[] = [
  {
    name: "release-desktop",
    description: "Build, sign and publish a desktop release of ace for both Mac CPUs.",
    body: body("Release desktop", "Use when the person asks to ship a desktop build."),
    scope: "project",
    workspaceId: "project",
    home: "claude",
    links: ["codex"],
    manual: true,
    argumentHint: "[version]",
    usage: { count: 6 },
  },
  {
    name: "research",
    description: "Investigate a question against primary sources and save the findings.",
    body: body("Research", "Use when the person wants a topic researched."),
    scope: "personal",
    links: ["claude"],
    usage: { count: 14 },
  },
  {
    name: "unslop",
    description: "Cut AI tells from any writing.",
    body: body("Unslop", "Apply to every piece of prose before it ships."),
    scope: "personal",
    links: ["claude"],
    usage: { count: 31 },
  },
  {
    name: "tdd",
    description: "Test-driven development with red-green-refactor.",
    body: body("TDD", "Write the failing test first."),
    scope: "personal",
  },
  {
    name: "frontend-design",
    description: "Distinctive, intentional visual design for new UI.",
    body: body("Frontend design", "Pick an aesthetic direction before writing markup."),
    scope: "personal",
    links: ["claude"],
    source: {
      source: "anthropics/skills",
      url: "https://github.com/anthropics/skills.git",
      path: "skills/frontend-design/SKILL.md",
      folderHash: "0d5b74a14bdf3ebcd64f352d06376a2ef05ed2c1",
      updatedAt: "2026-09-03T02:36:00.000Z",
    },
  },
  {
    name: "cloudflare",
    description: "Cloudflare platform skill covering Workers, Pages and storage.",
    body: body("Cloudflare", "Prefer retrieval from Cloudflare docs."),
    scope: "personal",
    home: "claude",
    copies: ["codex"],
  },
  {
    name: "review-changes",
    description: "Review the changes in this worktree before they are committed or merged.",
    body: body("Review changes", "Read the diff, then the files around it."),
    scope: "builtin",
  },
  {
    name: "deploy-preview",
    description: "Deploy a preview build from an installed ace plugin.",
    body: body("Deploy preview", "Shipped by a plugin."),
    scope: "plugin",
  },
];
function digest(text: string, length: number): string {
  let out = "";
  for (let round = 0; out.length < length; round++) {
    let hash = 0x811c9dc5 ^ round;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    out += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}
function frontmatter(seed: SkillSeed): string {
  const lines = [`name: ${seed.name}`, `description: ${JSON.stringify(seed.description)}`];
  if (seed.manual) lines.push("disable-model-invocation: true");
  if (seed.argumentHint) lines.push(`argument-hint: ${JSON.stringify(seed.argumentHint)}`);
  return `---\n${lines.join("\n")}\n---\n${seed.body}`;
}
/** In-memory skill library with the daemon's rules for agents, editing and updates. */
export class FakeSkillLibrary {
  private readonly skills = new Map<string, SkillSeed>();
  private readonly reviews = new Map<string, { id: string; after: string }>();
  private sequence = 0;
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
  constructor() {
    this.seed(defaults);
  }
  seed(seeds: readonly SkillSeed[]): void {
    this.skills.clear();
    for (const seed of seeds) this.skills.set(this.idOf(seed), { ...seed });
    this.notify();
  }
  private idOf(seed: Pick<SkillSeed, "name" | "scope" | "workspaceId">): string {
    return `skl_${digest(`${seed.scope}:${seed.workspaceId ?? ""}:${seed.name}`, 40)}`;
  }
  private path(seed: SkillSeed): string {
    const folder =
      seed.home === "claude"
        ? ".claude/skills"
        : seed.home === "codex"
          ? ".codex/skills"
          : ".agents/skills";
    if (seed.scope === "builtin") return `ace/skills/${seed.name}`;
    if (seed.scope === "plugin") return `~/.ace/plugins/deploy/skills/${seed.name}`;
    return seed.scope === "project" ? `${folder}/${seed.name}` : `~/${folder}/${seed.name}`;
  }
  private presence(seed: SkillSeed): SkillPresence[] {
    if (seed.scope === "builtin" || seed.scope === "plugin")
      return order.map((provider) => ({
        provider,
        via: "native",
        path: this.path(seed),
        removable: false,
        honoursManual: honours[provider],
      }));
    const prefix = seed.scope === "project" ? "" : "~/";
    const native = readers[seed.home ?? "agents"];
    const out: SkillPresence[] = [];
    for (const provider of order) {
      const via = native.includes(provider)
        ? "native"
        : seed.links?.includes(provider)
          ? "link"
          : seed.copies?.includes(provider)
            ? "copy"
            : undefined;
      if (!via) continue;
      out.push({
        provider,
        via,
        path: via === "native" ? this.path(seed) : `${prefix}${own[provider]}/${seed.name}`,
        removable: via === "link",
        honoursManual: honours[provider],
      });
    }
    return out;
  }
  private entry(id: string, seed: SkillSeed): SkillEntry {
    const text = frontmatter(seed);
    return {
      id,
      name: seed.name,
      title: seed.body.match(/^# (.+)$/m)?.[1],
      description: seed.description,
      scope: seed.scope,
      path: this.path(seed),
      agents: this.presence(seed),
      manual: seed.manual === true,
      ...(seed.argumentHint ? { argumentHint: seed.argumentHint } : {}),
      editable: seed.scope === "project" || seed.scope === "personal",
      ...(seed.source ? { source: seed.source } : {}),
      hash: digest(text, 64),
    };
  }
  list(workspaceId: string | undefined): SkillEntry[] {
    return [...this.skills]
      .filter(([, seed]) => seed.scope !== "project" || seed.workspaceId === workspaceId)
      .map(([id, seed]) => this.entry(id, seed));
  }
  request(operation: SkillOperation): SkillResult {
    if (operation.op === "list")
      return { kind: "list", entries: this.list(operation.workspaceId), stale: false };
    if (operation.op === "cancelUpdate") {
      this.reviews.delete(operation.reviewId);
      return { kind: "cancelled", reviewId: operation.reviewId };
    }
    if (operation.op === "usage")
      return {
        kind: "usage",
        usage: operation.ids.flatMap((id) => {
          const usage = this.skills.get(id)?.usage;
          return [{ id, count: usage?.count ?? 0, ...(usage?.last ? { last: usage.last } : {}) }];
        }),
      };
    if (operation.op === "create") {
      const seed: SkillSeed = {
        name: operation.name,
        description: operation.description,
        body: operation.body,
        scope: operation.scope.kind,
        ...(operation.scope.kind === "project" ? { workspaceId: operation.scope.workspaceId } : {}),
        links: operation.agents.filter((a) => !readers.agents.includes(a)),
        manual: operation.manual,
      };
      const id = this.idOf(seed);
      if (this.list(seed.workspaceId).some((entry) => entry.name === seed.name))
        return error("exists", `You already have a skill called ${seed.name}.`);
      this.skills.set(id, seed);
      return this.changed(id, seed);
    }
    const seed = this.skills.get(operation.id);
    if (!seed || (seed.scope === "project" && seed.workspaceId !== operation.workspaceId))
      return error("not_found", "This skill no longer exists. Reload the list.");
    const current = this.entry(operation.id, seed);
    if (operation.op === "read") return { kind: "skill", entry: current, text: frontmatter(seed) };
    if (!current.editable)
      return error("read_only", "Skills built into ace or plugins can't be changed here.");
    if (operation.op === "edit") {
      if (operation.expectedHash !== current.hash)
        return error("conflict", "This skill changed elsewhere. Reload it before saving.");
      Object.assign(seed, {
        description: operation.description,
        body: operation.body,
        manual: operation.manual,
      });
      return this.changed(operation.id, seed);
    }
    if (operation.op === "setAgents") {
      const kept: NonNullable<Extract<SkillResult, { kind: "skill" }>["kept"]> = [];
      for (const presence of current.agents)
        if (!operation.agents.includes(presence.provider) && !presence.removable)
          kept.push({
            provider: presence.provider,
            reason: presence.via === "copy" ? "copy" : "canonical",
          });
      seed.links = operation.agents.filter(
        (agent) => !readers[seed.home ?? "agents"].includes(agent) && !seed.copies?.includes(agent),
      );
      const result = this.changed(operation.id, seed);
      return result.kind === "skill" && kept.length ? { ...result, kept } : result;
    }
    if (operation.op === "delete") {
      if (operation.expectedHash !== current.hash)
        return error("conflict", "This skill changed elsewhere. Reload it before deleting.");
      this.skills.delete(operation.id);
      this.notify();
      return { kind: "deleted", id: operation.id };
    }
    if (!seed.source) return error("invalid", "This skill wasn't installed from a source.");
    const commit = digest(`${seed.source.url}:${seed.source.folderHash}`, 40);
    if (operation.op === "checkUpdate")
      return { kind: "updateStatus", id: operation.id, status: "available", commit };
    if (operation.op === "prepareUpdate") {
      const id = `review-${++this.sequence}`;
      const after = `${frontmatter(seed)}\n## What's new\n\nA clearer checklist.\n`;
      this.reviews.set(id, { id, after });
      return {
        kind: "updateReview",
        review: {
          id,
          skillId: operation.id,
          commit,
          folderHash: digest(after, 40),
          files: [
            { path: "SKILL.md", change: "changed", flagged: false },
            { path: "scripts/check.sh", change: "added", flagged: true },
          ],
          before: frontmatter(seed),
          after,
        },
      };
    }
    const review = this.reviews.get(operation.reviewId);
    if (!review) return error("not_found", "This update review expired. Check for updates again.");
    if (operation.expectedHash !== current.hash)
      return error("conflict", "This skill changed since the review. Check for updates again.");
    this.reviews.delete(review.id);
    seed.body = `${seed.body}\n## What's new\n\nA clearer checklist.\n`;
    seed.source = { ...seed.source, folderHash: digest(review.after, 40) };
    return this.changed(operation.id, seed);
  }
  private changed(id: string, seed: SkillSeed): SkillResult {
    this.notify();
    return { kind: "skill", entry: this.entry(id, seed), text: frontmatter(seed) };
  }
}
function error(
  code: Extract<SkillResult, { kind: "error" }>["code"],
  message: string,
): SkillResult {
  return { kind: "error", code, message };
}
