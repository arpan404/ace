import { describe, expect, test } from "vitest";
import {
  buildAzureUrl,
  buildCloudflareUrl,
  buildVertexUrl,
  mergeProviderTemplates,
} from "./spade-provider-catalog.ts";

describe("spade provider catalog", () => {
  test("builds Vertex AI's OpenAI-compatible endpoint for the global and regional hosts", () => {
    expect(buildVertexUrl("acme-prod", "global")).toBe(
      "https://aiplatform.googleapis.com/v1/projects/acme-prod/locations/global/endpoints/openapi/",
    );
    expect(buildVertexUrl("acme-prod", "us-central1")).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/acme-prod/locations/us-central1/endpoints/openapi/",
    );
  });

  test("builds Azure OpenAI and Cloudflare AI Gateway endpoints", () => {
    expect(buildAzureUrl("contoso-ai")).toBe("https://contoso-ai.openai.azure.com/openai/v1/");
    expect(buildCloudflareUrl("acc123", "prod-gw")).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc123/prod-gw/compat/",
    );
  });

  test("merges shipped presets first without duplicating built-in templates", () => {
    const merged = mergeProviderTemplates([
      {
        id: "openrouter",
        name: "OpenRouter",
        format: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1/",
        keyEnv: "OPENROUTER_API_KEY",
        sessionHeader: undefined,
      },
      {
        id: "openai",
        name: "OpenAI",
        format: "openai-responses",
        baseUrl: "https://api.openai.com/v1/",
        keyEnv: "OPENAI_API_KEY",
        sessionHeader: undefined,
      },
    ]);
    const openrouterMatches = merged.filter((item) => item.id === "openrouter");
    expect(openrouterMatches).toHaveLength(1);
    expect(openrouterMatches[0]?.shipped).toBe(true);
  });
});
