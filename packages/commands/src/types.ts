import type { PaletteCommand, CommandDiagnostic, ProviderKind } from "@ace/protocol";
export interface Definition extends PaletteCommand {
  body: string;
  format: "library" | "claude" | "codex" | "opencode" | "runtime" | "ace";
  raw: Record<string, unknown>;
  instance?: string;
  session?: string;
  priority: number;
  nativeName: string;
  unavailable?: boolean;
}
export interface ParsedSource {
  commands: Definition[];
  diagnostics: CommandDiagnostic[];
}
export interface ParseContext {
  source: string;
  name: string;
  scope: "user" | "workspace";
  format: "library" | "claude" | "codex" | "opencode";
  instance?: string;
  skill?: boolean;
}
export interface Target {
  provider: ProviderKind;
  instance: string;
  session: string;
}
export function metadata(d: Definition): PaletteCommand {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    namespace: d.namespace,
    provider: d.provider,
    arguments: d.arguments,
    scope: d.scope,
    ...(d.argumentHint === undefined ? {} : { argumentHint: d.argumentHint }),
  };
}
