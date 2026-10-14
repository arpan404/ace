import { CatalogModel } from "@ace/protocol";

/** Deliberately simulated capability: it never changes a real provider's catalog. */
export const ultraPreviewModel = CatalogModel.parse({
  id: "simulated-ultra-reasoning-extended-context-demonstration-model",
  displayName: "Simulated Ultra Reasoning with Extended Context Model",
  provider: "codex",
  instance: "codex-personal",
  source: { kind: "account", id: "codex-personal", label: "Personal" },
  nativeModelId: "simulated-ultra-reasoning-extended-context-demonstration-model",
  contextWindow: 400_000,
  efforts: [
    { id: "minimal", level: "minimal", label: "Minimal" },
    { id: "low", level: "low", label: "Low" },
    { id: "medium", level: "medium", label: "Medium" },
    { id: "high", level: "high", label: "High" },
    { id: "ultra", level: "ultra", label: "Ultra" },
  ],
  defaultEffort: "medium",
  serviceTiers: [
    { id: "default", name: "Standard", speed: "standard", parameters: { serviceTier: "default" } },
    { id: "priority", name: "Fast", speed: "fast", parameters: { serviceTier: "priority" } },
    {
      id: "ultrafast",
      name: "Ultrafast",
      speed: "ultrafast",
      parameters: { serviceTier: "ultrafast" },
    },
  ],
  inputModalities: ["text", "image"],
  isDefault: false,
  hidden: false,
  deprecated: false,
  raw: { json: '{"simulated":true}', truncated: false },
} satisfies CatalogModel);
