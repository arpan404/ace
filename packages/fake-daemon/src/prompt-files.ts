import { parseMarkdown } from "@ace/commands/prompt-format";
import type {
  PromptFile,
  PromptFileOperation,
  PromptFileResult,
  PromptFileScope,
  CatalogEntry,
  ProviderKind,
} from "@ace/protocol";
export interface PromptSeed {
  name: string;
  scope: PromptFileScope;
  text: string;
}
const defaults: PromptSeed[] = [
  {
    name: "explain.md",
    scope: { kind: "global" },
    text: "---\nname: explain\ndescription: Explain a change in plain language\narguments:\n  topic:\n    type: string\n    required: true\n---\nExplain {{topic}} with examples.",
  },
  {
    name: "unfinished.md",
    scope: { kind: "global" },
    text: "---\nname: [\n---\nFix this prompt's metadata.",
  },
];
export class FakePromptFiles {
  private sequence = 0;
  onChanged: (() => void) | undefined;
  private readonly files = new Map<string, { seed: PromptSeed; revision: string }>();
  constructor() {
    this.seed(defaults);
  }
  private key(scope: PromptFileScope, name: string) {
    return `${scope.kind === "global" ? "global" : scope.workspaceId}:${name}`;
  }
  seed(files: readonly PromptSeed[]) {
    this.files.clear();
    for (const seed of files)
      this.files.set(this.key(seed.scope, seed.name), { seed, revision: this.revision() });
    this.onChanged?.();
  }
  private revision() {
    return (++this.sequence).toString(16).padStart(64, "0");
  }
  private metadata(seed: PromptSeed): PromptFile {
    const parsed = parseMarkdown(seed.text, {
      source: seed.name,
      name: seed.name.slice(0, -3),
      scope: seed.scope.kind === "global" ? "user" : "workspace",
      format: "library",
    });
    return {
      ...seed,
      title: parsed.commands[0]?.name ?? seed.name.slice(0, -3).slice(0, 128),
      description: parsed.commands[0]?.description ?? "",
      diagnostics: parsed.diagnostics,
    };
  }
  catalog(workspaceId: string, provider: ProviderKind): CatalogEntry[] {
    const entries = new Map<string, CatalogEntry>();
    const seeds = [...this.files.values()]
      .map(({ seed }) => seed)
      .filter((seed) => seed.scope.kind === "global" || seed.scope.workspaceId === workspaceId)
      .toSorted((a, b) => Number(a.scope.kind === "project") - Number(b.scope.kind === "project"));
    for (const seed of seeds) {
      const source = `${this.key(seed.scope, seed.name)}`;
      const parsed = parseMarkdown(seed.text, {
        source,
        name: seed.name.slice(0, -3),
        format: "library",
        scope: seed.scope.kind === "global" ? "user" : "workspace",
      });
      for (const command of parsed.commands)
        if (command.extension && (command.provider === "any" || command.provider === provider))
          entries.set(command.name, command.extension);
    }
    return [...entries.values()];
  }
  request(operation: PromptFileOperation): PromptFileResult {
    if (operation.op === "list")
      return {
        kind: "list",
        files: [...this.files.values()]
          .filter(
            ({ seed }) =>
              seed.scope.kind === "global" || seed.scope.workspaceId === operation.workspaceId,
          )
          .map(({ seed }) => this.metadata(seed)),
      };
    const key = this.key(operation.scope, operation.name);
    const held = this.files.get(key);
    if (operation.op === "write") {
      if ((held?.revision ?? null) !== operation.expectedRevision)
        return {
          kind: "error",
          code: "conflict",
          message: "This prompt changed elsewhere. Reload it before saving.",
        };
      const next = {
        seed: { name: operation.name, scope: operation.scope, text: operation.text },
        revision: this.revision(),
      };
      this.files.set(key, next);
      this.onChanged?.();
      return {
        kind: "file",
        file: this.metadata(next.seed),
        text: operation.text,
        revision: next.revision,
      };
    }
    return held
      ? {
          kind: "file",
          file: this.metadata(held.seed),
          text: held.seed.text,
          revision: held.revision,
        }
      : {
          kind: "error",
          code: "not_found",
          message: "This prompt no longer exists. Choose another prompt.",
        };
  }
}
