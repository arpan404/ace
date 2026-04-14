import { describe, expect, it } from "vitest";

import {
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
            env: ["OPENROUTER_API_KEY"],
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
            env: ["OPENAI_API_KEY"],
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
            env: ["ANTHROPIC_API_KEY"],
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

  it("returns the full OpenCode provider catalog by default", () => {
    const hugeProviderList = {
      all: [
        {
          id: "openai",
          name: "OpenAI",
          env: ["OPENAI_API_KEY"],
          models: Object.fromEntries(
            Array.from({ length: 37 }, (_, index) => [
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

    const result = openCodeModelsFromProviderList(hugeProviderList);

    expect(result.models).toHaveLength(37);
    expect(result.totalModels).toBe(37);
    expect(result.truncated).toBe(false);
  });

  it("maps OpenCode model variants into selectable model capabilities", () => {
    const result = openCodeModelsFromProviderList({
      all: [
        {
          id: "openai",
          name: "OpenAI",
          env: ["OPENAI_API_KEY"],
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

  it("keeps the supplied provider catalog without local auth/free heuristics", () => {
    const result = openCodeModelsFromProviderList({
      all: [
        {
          id: "openai",
          name: "OpenAI",
          env: ["OPENAI_API_KEY"],
          models: {
            gpt5: {
              id: "gpt-5",
              name: "GPT-5",
              release_date: "2026-01-01",
              attachment: true,
              reasoning: true,
              tool_call: true,
              cost: {
                input: 2,
                output: 6,
              },
            },
          },
        },
        {
          id: "openrouter",
          name: "OpenRouter",
          env: ["OPENROUTER_API_KEY"],
          models: {
            free: {
              id: "qwen-free",
              name: "Qwen Free",
              release_date: "2026-01-01",
              attachment: true,
              reasoning: true,
              tool_call: true,
              cost: {
                input: 0,
                output: 0,
              },
            },
            paid: {
              id: "gpt-paid",
              name: "Paid GPT",
              release_date: "2026-01-01",
              attachment: true,
              reasoning: true,
              tool_call: true,
              cost: {
                input: 1,
                output: 1,
              },
            },
          },
        },
        {
          id: "lmstudio",
          name: "LMStudio",
          env: [],
          models: {
            local: {
              id: "qwen3-coder-30b",
              name: "Qwen3 Coder 30B",
              release_date: "2026-01-01",
              attachment: true,
              reasoning: true,
              tool_call: true,
            },
          },
        },
      ],
      default: {
        openai: "gpt-5",
      },
      connected: ["openai", "lmstudio"],
    });

    expect(result.totalModels).toBe(4);
    expect(result.models).toHaveLength(4);
    expect(result.models.map((model) => model.slug)).toEqual(
      expect.arrayContaining([
        "openai/gpt-5",
        "lmstudio/qwen3-coder-30b",
        "openrouter/qwen-free",
        "openrouter/gpt-paid",
      ]),
    );
  });
});

describe("searchOpenCodeModelsFromProviderList", () => {
  it("respects search pagination", () => {
    const result = searchOpenCodeModelsFromProviderList(
      {
        all: [
          {
            id: "anthropic",
            name: "Anthropic",
            env: ["ANTHROPIC_API_KEY"],
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

  it("returns all matching models from the supplied provider catalog", () => {
    const result = searchOpenCodeModelsFromProviderList(
      {
        all: [
          {
            id: "openrouter",
            name: "OpenRouter",
            env: ["OPENROUTER_API_KEY"],
            models: {
              free: {
                id: "gemma-free",
                name: "Gemma Free",
                family: "Gemma",
                release_date: "2026-01-10",
                attachment: true,
                reasoning: true,
                tool_call: true,
                cost: {
                  input: 0,
                  output: 0,
                },
              },
              paid: {
                id: "gemma-pro",
                name: "Gemma Pro",
                family: "Gemma",
                release_date: "2026-02-10",
                attachment: true,
                reasoning: true,
                tool_call: true,
                cost: {
                  input: 2,
                  output: 2,
                },
              },
            },
          },
        ],
        default: {},
        connected: [],
      },
      {
        query: "gemma",
        limit: 10,
        offset: 0,
      },
    );

    expect(result.models.map((model) => model.slug)).toEqual([
      "openrouter/gemma-pro",
      "openrouter/gemma-free",
    ]);
    expect(result.totalModels).toBe(2);
    expect(result.hasMore).toBe(false);
  });
});
