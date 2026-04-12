import { describe, expect, it } from "vitest";

import {
  OPENCODE_PROVIDER_MODEL_LIMIT,
  openCodeModelsFromProviderList,
  searchOpenCodeModelsFromProviderList,
} from "./opencodeSdk";

describe("openCodeModelsFromProviderList", () => {
  it("pins the latest release while keeping featured default models at the top", () => {
    const result = openCodeModelsFromProviderList(
      {
        all: [
          {
            id: "openrouter",
            name: "OpenRouter",
            models: {
              newest: {
                id: "gpt-6-preview",
                name: "GPT-6 Preview",
                release_date: "2026-03-20",
                attachment: true,
                reasoning: true,
                tool_call: true,
              },
            },
          },
          {
            id: "openai",
            name: "OpenAI",
            models: {
              gpt5: {
                id: "gpt-5",
                name: "GPT-5",
                release_date: "2026-01-01",
                attachment: true,
                reasoning: true,
                tool_call: true,
              },
              codex: {
                id: "gpt-5-codex",
                name: "GPT-5 Codex",
                release_date: "2026-02-01",
                attachment: true,
                reasoning: true,
                tool_call: true,
              },
            },
          },
          {
            id: "anthropic",
            name: "Anthropic",
            models: {
              sonnet: {
                id: "claude-sonnet-4-7",
                name: "Claude Sonnet 4.7",
                release_date: "2026-02-15",
                attachment: true,
                reasoning: true,
                tool_call: true,
              },
            },
          },
        ],
        default: {
          openai: "gpt-5",
          anthropic: "claude-sonnet-4-7",
        },
        connected: ["openai", "anthropic"],
      },
      {
        maxModels: 3,
      },
    );

    expect(result.totalModels).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.models.map((model) => model.slug)).toEqual([
      "openrouter/gpt-6-preview",
      "anthropic/claude-sonnet-4-7",
      "openai/gpt-5",
    ]);
  });

  it("uses the repository-wide OpenCode snapshot limit by default", () => {
    const hugeProviderList = {
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: Object.fromEntries(
            Array.from({ length: OPENCODE_PROVIDER_MODEL_LIMIT + 5 }, (_, index) => [
              `model-${String(index + 1)}`,
              {
                id: `model-${String(index + 1)}`,
                name: `Model ${String(index + 1)}`,
                release_date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
                attachment: true,
                reasoning: true,
                tool_call: true,
              },
            ]),
          ),
        },
      ],
      default: {
        openai: "model-1",
      },
      connected: ["openai"],
    };

    const result = openCodeModelsFromProviderList(hugeProviderList, {
      maxModels: OPENCODE_PROVIDER_MODEL_LIMIT,
    });

    expect(result.models).toHaveLength(OPENCODE_PROVIDER_MODEL_LIMIT);
    expect(result.totalModels).toBe(OPENCODE_PROVIDER_MODEL_LIMIT + 5);
    expect(result.truncated).toBe(true);
  });

  it("maps OpenCode model variants into selectable model capabilities", () => {
    const result = openCodeModelsFromProviderList({
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            gpt5: {
              id: "gpt-5",
              name: "GPT-5",
              release_date: "2026-01-01",
              attachment: true,
              reasoning: true,
              tool_call: true,
              variants: {
                default: {},
                balanced: {},
              },
            },
          },
        },
      ],
      default: {
        openai: "gpt-5",
      },
      connected: ["openai"],
    });

    expect(result.models[0]?.capabilities?.contextWindowOptions).toEqual([
      { value: "default", label: "Default", isDefault: true },
      { value: "balanced", label: "Balanced" },
    ]);
  });
});

describe("searchOpenCodeModelsFromProviderList", () => {
  it("returns search results in 10-model pages", () => {
    const result = searchOpenCodeModelsFromProviderList(
      {
        all: [
          {
            id: "anthropic",
            name: "Anthropic",
            models: {
              sonnetA: {
                id: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                family: "Claude Sonnet",
                release_date: "2026-02-10",
                attachment: true,
                reasoning: true,
                tool_call: true,
              },
              sonnetB: {
                id: "claude-sonnet-4-7",
                name: "Claude Sonnet 4.7",
                family: "Claude Sonnet",
                release_date: "2026-03-10",
                attachment: true,
                reasoning: true,
                tool_call: true,
              },
              haiku: {
                id: "claude-haiku-4-5",
                name: "Claude Haiku 4.5",
                family: "Claude Haiku",
                release_date: "2026-01-10",
                attachment: true,
                reasoning: true,
                tool_call: true,
              },
            },
          },
        ],
        default: {
          anthropic: "claude-sonnet-4-7",
        },
        connected: ["anthropic"],
      },
      {
        query: "sonnet",
        limit: 1,
        offset: 0,
      },
    );

    expect(result.models.map((model) => model.slug)).toEqual(["anthropic/claude-sonnet-4-7"]);
    expect(result.totalModels).toBe(2);
    expect(result.nextOffset).toBe(1);
    expect(result.hasMore).toBe(true);
  });
});
