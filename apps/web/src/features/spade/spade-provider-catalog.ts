import { serviceInfo } from "@ace/ui-core";
import type { SpadeFormat, SpadePreset } from "@ace/ui-core/spade-chat";

export type CloudProviderKind = "vertex" | "azure" | "cloudflare";

export interface SpadeProviderTemplate {
  id: string;
  name: string;
  description: string;
  brandId: string;
  format: SpadeFormat;
  baseUrl: string;
  sessionHeader?: string;
  cloud?: CloudProviderKind;
  /** True when backed by one of Spade's shipped presets (so its `preset` id is submitted). */
  shipped?: boolean;
}

export interface GcpRegionOption {
  value: string;
  label: string;
}

export const gcpRegions: readonly GcpRegionOption[] = [
  { value: "global", label: "Global (recommended)" },
  { value: "us-central1", label: "us-central1 · Iowa" },
  { value: "us-east5", label: "us-east5 · Columbus" },
  { value: "us-east4", label: "us-east4 · Northern Virginia" },
  { value: "us-west1", label: "us-west1 · Oregon" },
  { value: "us-west4", label: "us-west4 · Las Vegas" },
  { value: "europe-west4", label: "europe-west4 · Netherlands" },
  { value: "europe-west1", label: "europe-west1 · Belgium" },
  { value: "asia-northeast1", label: "asia-northeast1 · Tokyo" },
  { value: "asia-southeast1", label: "asia-southeast1 · Singapore" },
  { value: "custom", label: "Other region…" },
];

export function buildVertexUrl(project: string, region: string, format: SpadeFormat): string {
  const cleanProject = project.trim() || "PROJECT_ID";
  const cleanRegion = region.trim() || "global";
  const host =
    cleanRegion === "global"
      ? "aiplatform.googleapis.com"
      : `${cleanRegion}-aiplatform.googleapis.com`;
  if (format === "anthropic") {
    return `https://${host}/v1/projects/${cleanProject}/locations/${cleanRegion}/publishers/anthropic/models/`;
  }
  return `https://${host}/v1/projects/${cleanProject}/locations/${cleanRegion}/endpoints/openapi/`;
}

export function buildAzureUrl(resource: string): string {
  const clean = resource.trim() || "RESOURCE_NAME";
  return `https://${clean}.openai.azure.com/openai/v1/`;
}

export function buildCloudflareUrl(accountId: string, gateway: string): string {
  const cleanAccount = accountId.trim() || "ACCOUNT_ID";
  const cleanGateway = gateway.trim() || "GATEWAY_NAME";
  return `https://gateway.ai.cloudflare.com/v1/${cleanAccount}/${cleanGateway}/compat/`;
}

const builtinTemplates: readonly SpadeProviderTemplate[] = [
  {
    id: "google-vertex",
    name: "Google Vertex AI",
    description: "GCP project & region",
    brandId: "google-vertex",
    format: "openai-chat",
    baseUrl: buildVertexUrl("", "global", "openai-chat"),
    cloud: "vertex",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Many providers, one key",
    brandId: "openrouter",
    format: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1/",
  },
  {
    id: "groq",
    name: "Groq",
    description: "Fast LPU inference",
    brandId: "groq",
    format: "openai-chat",
    baseUrl: "https://api.groq.com/openai/v1/",
  },
  {
    id: "together",
    name: "Together AI",
    description: "Open-weight models",
    brandId: "together",
    format: "openai-chat",
    baseUrl: "https://api.together.xyz/v1/",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    description: "Low-latency inference",
    brandId: "fireworks",
    format: "openai-chat",
    baseUrl: "https://api.fireworks.ai/inference/v1/",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek API",
    brandId: "deepseek",
    format: "openai-chat",
    baseUrl: "https://api.deepseek.com/v1/",
  },
  {
    id: "xai",
    name: "xAI",
    description: "Grok models",
    brandId: "xai",
    format: "openai-chat",
    baseUrl: "https://api.x.ai/v1/",
  },
  {
    id: "mistral",
    name: "Mistral",
    description: "Mistral API",
    brandId: "mistral",
    format: "openai-chat",
    baseUrl: "https://api.mistral.ai/v1/",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    description: "Ultra-fast inference",
    brandId: "cerebras",
    format: "openai-chat",
    baseUrl: "https://api.cerebras.ai/v1/",
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    description: "Azure resource endpoint",
    brandId: "openai",
    format: "openai-responses",
    baseUrl: buildAzureUrl(""),
    cloud: "azure",
  },
  {
    id: "cloudflare-ai",
    name: "Cloudflare AI Gateway",
    description: "Unified gateway routing",
    brandId: "cloudflare",
    format: "openai-chat",
    baseUrl: buildCloudflareUrl("", ""),
    cloud: "cloudflare",
  },
  {
    id: "moonshot",
    name: "Moonshot",
    description: "Kimi models",
    brandId: "moonshot",
    format: "openai-chat",
    baseUrl: "https://api.moonshot.ai/v1/",
  },
  {
    id: "minimax",
    name: "MiniMax",
    description: "MiniMax models",
    brandId: "minimax",
    format: "openai-chat",
    baseUrl: "https://api.minimax.io/v1/",
  },
  {
    id: "zai",
    name: "Z.AI",
    description: "GLM models",
    brandId: "zai",
    format: "openai-chat",
    baseUrl: "https://api.z.ai/api/paas/v4/",
  },
];

/**
 * Shipped presets first (so their `preset` id is preserved on submit), followed by curated cloud
 * and inference templates not already covered by a preset.
 */
export function mergeProviderTemplates(presets: readonly SpadePreset[]): SpadeProviderTemplate[] {
  const seen = new Set<string>();
  const out: SpadeProviderTemplate[] = [];
  for (const preset of presets) {
    const key = preset.id.toLowerCase();
    seen.add(key);
    out.push({
      id: preset.id,
      name: preset.name,
      description: serviceInfo(preset.id).description ?? "Preset provider",
      brandId: preset.id,
      format: preset.format ?? "openai-chat",
      baseUrl: preset.baseUrl,
      ...(preset.sessionHeader ? { sessionHeader: preset.sessionHeader } : {}),
      shipped: true,
    });
  }
  for (const template of builtinTemplates) {
    if (seen.has(template.id.toLowerCase())) continue;
    seen.add(template.id.toLowerCase());
    out.push(template);
  }
  return out;
}
