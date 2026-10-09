import type { FakePromptFiles } from "./prompt-files.ts";
import type { CatalogEntry, ClientMessage, ProviderKind, ServerMessage } from "@ace/protocol";
import { extensionCatalog } from "./catalog/extensions.ts";
import type { FakeServiceContext } from "./service-context.ts";
import type { FakeContextWire } from "./context-wire.ts";
import type { FakeWireSession } from "./service-context.ts";
export class FakeCatalogWire {
  constructor(
    privatePrompts: FakePromptFiles,
    extras: (provider: ProviderKind) => CatalogEntry[] = () => [],
  ) {
    this.prompts = privatePrompts;
    this.extras = extras;
    privatePrompts.onChanged = () => this.invalidate();
  }
  private readonly extras: (provider: ProviderKind) => CatalogEntry[];
  private readonly prompts: FakePromptFiles;
  invalidate(): void {
    for (const listener of this.listeners) listener();
  }
  private readonly overrides = new Map<ProviderKind, CatalogEntry[]>();
  private readonly listeners = new Set<() => void>();
  private loading: readonly ProviderKind[] = [];
  seed(
    overrides: Partial<Record<ProviderKind, CatalogEntry[]>>,
    loading: readonly ProviderKind[] = [],
  ): void {
    this.loading = loading;
    this.overrides.clear();
    for (const [provider, entries] of Object.entries(overrides))
      for (const kind of [
        "claude",
        "codex",
        "opencode",
        "cursor",
        "pi",
        "acp",
        "antigravity",
      ] as const)
        if (provider === kind && entries) this.overrides.set(kind, entries.slice(0, 512));
    for (const listener of this.listeners) listener();
  }
  session(
    host: FakeServiceContext,
    drafts: FakeContextWire,
    send: (message: ServerMessage) => void,
  ): FakeWireSession {
    const subscriptions = new Map<string, Extract<ClientMessage, { type: "catalog.list" }>>();
    let owner = "";
    const read = (message: Extract<ClientMessage, { type: "catalog.list" }>) => {
      const thread = message.threadId ? host.thread(message.threadId)?.thread : undefined;
      const draft = message.draft;
      if (
        !message.workspace &&
        !thread &&
        (!draft || drafts.draftWorkspace(owner, draft.draftId) !== draft.workspaceId)
      )
        throw new Error("catalog_context_unavailable");
      const provider = thread?.provider ?? draft?.provider ?? message.workspace?.provider;
      const project = thread?.workspaceId ?? draft?.workspaceId ?? message.workspace?.workspaceId;
      if (!provider || !project) throw new Error("catalog_context_unavailable");
      const query = message.query.toLowerCase().replace(/^\//, "");
      return {
        entries: [
          ...(this.overrides.get(provider) ??
            extensionCatalog(
              provider,
              project,
              draft?.instanceId ??
                message.workspace?.instanceId ??
                thread?.imported?.instanceId ??
                thread?.execution?.instanceId ??
                provider,
            )),
          ...this.extras(provider),
          ...this.prompts.catalog(project, provider),
        ]
          .filter((e) => `${e.name} ${e.description}`.toLowerCase().includes(query))
          .slice(0, message.limit),
        stale: this.loading.includes(provider),
      };
    };
    const changed = () => {
      for (const request of subscriptions.values()) {
        try {
          send({ type: "catalog.changed", requestId: request.requestId, ...read(request) });
        } catch {
          subscriptions.delete(request.requestId);
        }
      }
    };
    if (this.listeners.size >= 64) throw new Error("Catalog connection limit");
    this.listeners.add(changed);
    return {
      authenticated(device) {
        owner = device;
      },
      close: () => {
        subscriptions.clear();
        this.listeners.delete(changed);
      },
      async handle(message) {
        if (message.type === "catalog.unsubscribe") {
          subscriptions.delete(message.requestId);
          return;
        }
        if (message.type !== "catalog.list") return;
        const result = read(message);
        if (message.subscribe) {
          if (subscriptions.size >= 8 && !subscriptions.has(message.requestId))
            throw new Error("catalog_subscription_limit");
          subscriptions.set(message.requestId, message);
        }
        send({ type: "catalog.list.result", requestId: message.requestId, ...result });
      },
    };
  }
}
