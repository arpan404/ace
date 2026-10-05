import {
  ProviderKind,
  PluginReview,
  PluginInstall,
  ServerMessage,
  type PluginClientMessage,
  type PluginAvailability,
  type PluginComponent,
  type PluginExecution as Execution,
} from "@ace/protocol";
import type { z } from "zod";

type PluginExecution = z.infer<typeof Execution>;
import { FakeByteRing } from "./byte-ring.ts";

const sourcePath = "skills/example/SKILL.md";
const inlinePath = ".ace-inline/commands/example.md";
interface Source {
  text: string;
  hash: string;
  virtual: boolean;
}
interface Component {
  name: string;
  kind: PluginComponent["kind"];
  path: string;
  description: string;
  source: Source;
}

/** A component a seeded or marketplace plugin ships: a skill, command, agent or rule. */
export interface FakePluginComponent {
  name: string;
  kind: PluginComponent["kind"];
  path: string;
  description: string;
  text: string;
}
/** A plugin the fake marketplace offers: what installing it would run, and what it ships. */
export interface FakePlugin {
  name: string;
  version: string;
  executions: PluginExecution[];
  components: FakePluginComponent[];
}
export interface PluginSeed {
  /** Installed and accepted, as if reviewed earlier. */
  installed?: (FakePlugin & {
    acceptedAt: number;
    enabled?: boolean;
    providers?: ProviderKind[];
  })[];
  /** Offered by `plugins.prepare` under their name, from any repository. */
  marketplace?: FakePlugin[];
}

export class FakePluginsWire {
  private components = new Map<string, Component[]>();
  private prepared = new Map<string, Component[]>();
  private reviews = new Map<string, PluginReview>();
  private installs = new Map<string, PluginInstall>();
  private policies = new Map<string, PluginAvailability>();
  private marketplace = new Map<string, FakePlugin>();
  /** Where each review's plugin was fetched from, kept on the install it becomes. */
  private sources = new Map<string, { repository: string; ref: string }>();
  private counter = 0;
  private availability(name: string) {
    const policy = this.policies.get(name);
    return {
      enabled: policy?.enabled ?? true,
      providers: policy?.providers ?? ProviderKind.options,
    };
  }
  seed(seed: PluginSeed): void {
    for (const plugin of seed.marketplace ?? []) this.marketplace.set(plugin.name, plugin);
    for (const plugin of seed.installed ?? []) {
      const components = built(plugin.components);
      const install = PluginInstall.parse({
        name: plugin.name,
        version: plugin.version,
        commit: "b".repeat(40),
        hash: fingerprint(JSON.stringify(plugin.components)),
        acceptedAt: plugin.acceptedAt,
        repository: `https://github.com/ace-fixtures/${plugin.name}.git`,
        ref: "main",
      });
      this.installs.set(install.name, install);
      this.components.set(install.name, components);
      if (plugin.enabled !== undefined || plugin.providers)
        this.policies.set(plugin.name, {
          name: plugin.name,
          enabled: plugin.enabled ?? true,
          providers: plugin.providers ?? ProviderKind.options,
        });
    }
  }
  private review(name: string, version: string, commit: string, hash: string) {
    return PluginReview.parse({
      id: `review-${++this.counter}`,
      name,
      version,
      commit,
      hash,
      executions: this.marketplace.get(name)?.executions ?? [],
      unsupported: [],
    });
  }
  private component(name: string, path: string): Component | undefined {
    return this.components.get(name)?.find((component) => component.path === path);
  }
  async handle(message: PluginClientMessage) {
    const request = message.request;
    const reply = (response: unknown) =>
      ServerMessage.parse({ type: "pluginResult", requestId: message.requestId, response });
    switch (request.type) {
      case "plugins.prepare": {
        if (this.reviews.size >= 32) throw new Error("review_limit");
        const offered = this.marketplace.get(request.name);
        const components = offered
          ? built(offered.components)
          : [await example(request.name === "inline-example")];
        const review = this.review(
          request.name,
          offered?.version ?? "1.0.0",
          "a".repeat(40),
          (this.counter + 1).toString(16).padStart(64, "0"),
        );
        this.reviews.set(review.id, review);
        this.prepared.set(review.id, components);
        this.sources.set(review.id, { repository: request.repository, ref: request.ref });
        return reply({ type: "plugins.review", review });
      }
      case "plugins.marketplace":
        // Any repository offers the fake marketplace, at the remote's HEAD unless asked.
        return reply({
          type: "plugins.marketplace",
          ref: request.ref ?? "HEAD",
          plugins: [...this.marketplace.values()].map((plugin) => ({
            name: plugin.name,
            version: plugin.version,
            description: shipped(plugin.components),
          })),
        });
      case "plugins.accept": {
        const review = this.reviews.get(request.id);
        if (!review || review.commit !== request.commit || review.hash !== request.hash)
          throw new Error("review_mismatch");
        if (!this.installs.has(review.name) && this.installs.size >= 256)
          throw new Error("install_limit");
        const origin = this.sources.get(review.id) ?? this.installs.get(review.name);
        const install = PluginInstall.parse({
          name: review.name,
          version: review.version,
          commit: review.commit,
          hash: review.hash,
          acceptedAt: 0,
          ...(origin?.repository ? { repository: origin.repository } : {}),
          ...(origin?.ref ? { ref: origin.ref } : {}),
        });
        this.installs.set(install.name, install);
        const components = this.prepared.get(review.id);
        if (components) this.components.set(install.name, components);
        this.prepared.delete(review.id);
        this.reviews.delete(review.id);
        this.sources.delete(review.id);
        return reply({ type: "plugins.installed", install });
      }
      case "plugins.cancel":
        this.reviews.delete(request.id);
        this.prepared.delete(request.id);
        this.sources.delete(request.id);
        return reply({ type: "plugins.cancelled", id: request.id });
      case "plugins.remove":
        this.installs.delete(request.name);
        this.policies.delete(request.name);
        this.components.delete(request.name);
        return reply({ type: "plugins.removed", name: request.name });
      case "plugins.availability": {
        if (!this.installs.has(request.name)) throw new Error("not_found");
        const availability = {
          name: request.name,
          enabled: request.enabled,
          providers: request.providers,
        };
        this.policies.set(request.name, availability);
        return reply({ type: "plugins.availability", availability });
      }
      case "plugins.catalog": {
        const all = [...this.installs.keys()]
          .toSorted((a, b) => a.localeCompare(b))
          .flatMap((plugin) =>
            (this.components.get(plugin) ?? []).map((component) =>
              Object.assign(
                {
                  plugin,
                  name: component.name,
                  kind: component.kind,
                  path: component.path,
                  description: component.description,
                },
                this.availability(plugin),
              ),
            ),
          );
        return reply({
          type: "plugins.catalog",
          components: all.slice(request.offset, request.offset + request.limit),
          ...(all.length > request.offset + request.limit
            ? { nextOffset: request.offset + request.limit }
            : {}),
        });
      }
      case "plugins.source": {
        const content = this.component(request.name, request.path)?.source;
        if (!content) throw new Error("not_found");
        const bytes = new TextEncoder().encode(content.text);
        const ring = new FakeByteRing(Math.max(1, bytes.length));
        ring.append(bytes);
        if (request.offset > bytes.length || ring.align(request.offset) !== request.offset)
          throw new Error("invalid_offset");
        const text = ring.read(request.offset, request.limit);
        return reply({
          type: "plugins.source",
          path: `/fake/plugins/${request.name}/${content.virtual ? ".claude-plugin/plugin.json" : request.path}`,
          ...(content.virtual ? { virtual: true, manifestPath: ".claude-plugin/plugin.json" } : {}),
          hash: content.hash,
          bytes: bytes.length,
          offset: request.offset,
          nextOffset: request.offset + new TextEncoder().encode(text).length,
          text,
          readonly: true,
        });
      }
      case "plugins.edit": {
        const install = this.installs.get(request.name);
        const current = this.component(request.name, request.path);
        if (!current || !install) throw new Error("not_found");
        if (current.source.hash !== request.expectedHash) throw new Error("source_changed");
        if (new TextEncoder().encode(request.text).length > 262144 || this.reviews.size >= 32)
          throw new Error("review_limit");
        const edited = await source(request.text, current.source.virtual);
        const review = this.review(install.name, install.version, install.commit, edited.hash);
        this.reviews.set(review.id, review);
        this.prepared.set(
          review.id,
          (this.components.get(request.name) ?? []).map((component) =>
            component.path === request.path
              ? Object.assign({}, component, { source: edited })
              : component,
          ),
        );
        return reply({ type: "plugins.review", review });
      }
      case "plugins.update": {
        const install = this.installs.get(request.name);
        const components = this.components.get(request.name);
        if (!install || !components) throw new Error("not_found");
        if (this.reviews.size >= 32) throw new Error("review_limit");
        const review = this.review(install.name, install.version, install.commit, install.hash);
        this.reviews.set(review.id, review);
        this.prepared.set(review.id, components);
        return reply({ type: "plugins.review", review });
      }
      case "plugins.list":
        return reply({
          type: "plugins.list",
          installs: [...this.installs.values()],
          reviews: [...this.reviews.values()].map(summary),
          availability: [...this.installs.keys()].map((name) =>
            Object.assign({ name }, this.availability(name)),
          ),
        });
      case "plugins.readReview": {
        const review = this.reviews.get(request.id);
        if (!review) throw new Error("not_found");
        return reply({
          type: "plugins.reviewPage",
          review: summary(review),
          entries: review.executions
            .slice(request.offset)
            .map((execution) => ({ type: "execution", execution })),
        });
      }
      default:
        throw new Error("Source fixture unavailable");
    }
  }
}

/** "2 skills, 1 command": what a marketplace plugin ships, for its listing. */
function shipped(components: readonly FakePluginComponent[]): string {
  const counts = new Map<string, number>();
  for (const component of components)
    counts.set(component.kind, (counts.get(component.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : "s"}`).join(", ");
}

function summary({ executions, unsupported, ...review }: PluginReview) {
  return Object.assign({}, review, {
    executionCount: executions.length,
    unsupportedCount: unsupported.length,
  });
}

async function example(virtual: boolean): Promise<Component> {
  return {
    name: "example",
    kind: virtual ? "command" : "skill",
    path: virtual ? inlinePath : sourcePath,
    description: "A synthetic fixture skill.",
    source: await source("# Example skill\nA synthetic fixture skill.\n", virtual),
  };
}

/** Seeded and marketplace components, hashed synchronously so a seed is ready at once. */
function built(components: readonly FakePluginComponent[]): Component[] {
  return components.map((component) => ({
    name: component.name,
    kind: component.kind,
    path: component.path,
    description: component.description,
    source: { text: component.text, virtual: false, hash: fingerprint(component.text) },
  }));
}

/** A stable 64-hex fingerprint (FNV-1a in eight lanes); the fake only compares it. */
function fingerprint(text: string): string {
  let out = "";
  for (let lane = 0; lane < 8; lane++) {
    let hash = (0x811c9dc5 ^ lane) >>> 0;
    for (let index = 0; index < text.length; index++)
      hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
    out += hash.toString(16).padStart(8, "0");
  }
  return out;
}

async function source(text: string, virtual = false): Promise<Source> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { text, virtual, hash };
}
