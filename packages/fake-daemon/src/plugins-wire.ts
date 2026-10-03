import {
  ProviderKind,
  PluginReview,
  PluginInstall,
  ServerMessage,
  type PluginClientMessage,
  type PluginAvailability,
} from "@ace/protocol";
import { FakeByteRing } from "./byte-ring.ts";
const sourcePath = "skills/example/SKILL.md";
const inlinePath = ".ace-inline/commands/example.md";
interface Source {
  text: string;
  hash: string;
  virtual: boolean;
}
export class FakePluginsWire {
  private source = new Map<string, Source>();
  private prepared = new Map<string, Source>();
  private reviews = new Map<string, PluginReview>();
  private installs = new Map<string, PluginInstall>();
  private policies = new Map<string, PluginAvailability>();
  private counter = 0;
  private availability(name: string) {
    const policy = this.policies.get(name);
    return {
      enabled: policy?.enabled ?? true,
      providers: policy?.providers ?? ProviderKind.options,
    };
  }
  async handle(message: PluginClientMessage) {
    const request = message.request;
    const reply = (response: unknown) =>
      ServerMessage.parse({ type: "pluginResult", requestId: message.requestId, response });
    switch (request.type) {
      case "plugins.prepare": {
        if (this.reviews.size >= 32) throw new Error("review_limit");
        const review = PluginReview.parse({
          id: `review-${++this.counter}`,
          name: request.name,
          version: "1.0.0",
          commit: "a".repeat(40),
          hash: this.counter.toString(16).padStart(64, "0"),
          executions: [],
          unsupported: [],
        });
        this.reviews.set(review.id, review);
        this.prepared.set(
          review.id,
          await source(
            "# Example skill\nA synthetic fixture skill.\n",
            request.name === "inline-example",
          ),
        );
        return reply({ type: "plugins.review", review });
      }
      case "plugins.accept": {
        const review = this.reviews.get(request.id);
        if (!review || review.commit !== request.commit || review.hash !== request.hash)
          throw new Error("review_mismatch");
        if (this.installs.size >= 256) throw new Error("install_limit");
        const install = PluginInstall.parse({
          name: review.name,
          version: review.version,
          commit: review.commit,
          hash: review.hash,
          acceptedAt: 0,
        });
        this.installs.set(install.name, install);
        const content = this.prepared.get(review.id);
        if (content) this.source.set(install.name, content);
        this.prepared.delete(review.id);
        this.reviews.delete(review.id);
        return reply({ type: "plugins.installed", install });
      }
      case "plugins.cancel":
        this.reviews.delete(request.id);
        this.prepared.delete(request.id);
        return reply({ type: "plugins.cancelled", id: request.id });
      case "plugins.remove":
        this.installs.delete(request.name);
        this.policies.delete(request.name);
        this.source.delete(request.name);
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
        const installs = [...this.installs.values()].toSorted((a, b) =>
          a.name.localeCompare(b.name),
        );
        return reply({
          type: "plugins.catalog",
          components: installs
            .slice(request.offset, request.offset + request.limit)
            .map((install) =>
              Object.assign(
                {
                  plugin: install.name,
                  name: "example",
                  kind: this.source.get(install.name)?.virtual ? "command" : "skill",
                  path: this.source.get(install.name)?.virtual ? inlinePath : sourcePath,
                  description: "A synthetic fixture skill.",
                },
                this.availability(install.name),
              ),
            ),
          ...(installs.length > request.offset + request.limit
            ? { nextOffset: request.offset + request.limit }
            : {}),
        });
      }
      case "plugins.source": {
        const content = this.source.get(request.name);
        if (!content || request.path !== (content.virtual ? inlinePath : sourcePath))
          throw new Error("not_found");
        const bytes = new TextEncoder().encode(content.text);
        const ring = new FakeByteRing(Math.max(1, bytes.length));
        ring.append(bytes);
        if (request.offset > bytes.length || ring.align(request.offset) !== request.offset)
          throw new Error("invalid_offset");
        const text = ring.read(request.offset, request.limit);
        return reply({
          type: "plugins.source",
          path: `/fake/plugins/${request.name}/${content.virtual ? ".claude-plugin/plugin.json" : sourcePath}`,
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
        const content = this.source.get(request.name),
          install = this.installs.get(request.name);
        if (!content || !install || request.path !== (content.virtual ? inlinePath : sourcePath))
          throw new Error("not_found");
        if (content.hash !== request.expectedHash) throw new Error("source_changed");
        if (new TextEncoder().encode(request.text).length > 262144 || this.reviews.size >= 32)
          throw new Error("review_limit");
        const edited = await source(request.text, content.virtual);
        const review = PluginReview.parse({
          id: `review-${++this.counter}`,
          name: install.name,
          version: install.version,
          commit: install.commit,
          hash: edited.hash,
          executions: [],
          unsupported: [],
        });
        this.reviews.set(review.id, review);
        this.prepared.set(review.id, edited);
        return reply({ type: "plugins.review", review });
      }
      case "plugins.update": {
        const install = this.installs.get(request.name),
          content = this.source.get(request.name);
        if (!install || !content) throw new Error("not_found");
        if (this.reviews.size >= 32) throw new Error("review_limit");
        const { acceptedAt: _acceptedAt, ...pin } = install;
        const review = PluginReview.parse({
          ...pin,
          id: `review-${++this.counter}`,
          executions: [],
          unsupported: [],
        });
        this.reviews.set(review.id, review);
        this.prepared.set(review.id, content);
        return reply({ type: "plugins.review", review });
      }
      case "plugins.list":
        return reply({
          type: "plugins.list",
          installs: [...this.installs.values()],
          reviews: [...this.reviews.values()].map(({ executions, unsupported, ...review }) =>
            Object.assign({}, review, {
              executionCount: executions.length,
              unsupportedCount: unsupported.length,
            }),
          ),
          availability: [...this.installs.keys()].map((name) =>
            Object.assign({ name }, this.availability(name)),
          ),
        });
      case "plugins.readReview": {
        const review = this.reviews.get(request.id);
        if (!review) throw new Error("not_found");
        const { executions, unsupported, ...summary } = review;
        return reply({
          type: "plugins.reviewPage",
          review: {
            ...summary,
            executionCount: executions.length,
            unsupportedCount: unsupported.length,
          },
          entries: [],
        });
      }
      default:
        throw new Error("Source fixture unavailable");
    }
  }
}

async function source(text: string, virtual = false) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return {
    text,
    virtual,
    hash: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}
