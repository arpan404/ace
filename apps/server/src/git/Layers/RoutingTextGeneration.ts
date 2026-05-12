/**
 * RoutingTextGeneration – Dispatches text generation requests to the provider-
 * specific implementation selected in each request input.
 *
 * Each supported provider gets its own dedicated text-generation backend so the
 * Git/title flows use the same provider the user selected.
 *
 * @module RoutingTextGeneration
 */
import { type ModelSelection, type ProviderKind } from "@ace/contracts";
import { Effect, Layer, ServiceMap } from "effect";

import {
  TextGeneration,
  type TextGenerationProvider,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import { CursorTextGenerationLive } from "./CursorTextGeneration.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";
import { GeminiTextGenerationLive } from "./GeminiTextGeneration.ts";
import { GitHubCopilotTextGenerationLive } from "./GitHubCopilotTextGeneration.ts";
import { OpenCodeTextGenerationLive } from "./OpenCodeTextGeneration.ts";

// ---------------------------------------------------------------------------
// Internal service tags so both concrete layers can coexist.
// ---------------------------------------------------------------------------

class CodexTextGen extends ServiceMap.Service<CodexTextGen, TextGenerationShape>()(
  "ace/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}

class ClaudeTextGen extends ServiceMap.Service<ClaudeTextGen, TextGenerationShape>()(
  "ace/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}

class GitHubCopilotTextGen extends ServiceMap.Service<GitHubCopilotTextGen, TextGenerationShape>()(
  "ace/git/Layers/RoutingTextGeneration/GitHubCopilotTextGen",
) {}

class CursorTextGen extends ServiceMap.Service<CursorTextGen, TextGenerationShape>()(
  "ace/git/Layers/RoutingTextGeneration/CursorTextGen",
) {}

class GeminiTextGen extends ServiceMap.Service<GeminiTextGen, TextGenerationShape>()(
  "ace/git/Layers/RoutingTextGeneration/GeminiTextGen",
) {}

class OpenCodeTextGen extends ServiceMap.Service<OpenCodeTextGen, TextGenerationShape>()(
  "ace/git/Layers/RoutingTextGeneration/OpenCodeTextGen",
) {}

const isTextGenerationProvider = (provider: ProviderKind): provider is TextGenerationProvider =>
  provider === "codex" ||
  provider === "claudeAgent" ||
  provider === "githubCopilot" ||
  provider === "cursor" ||
  provider === "gemini" ||
  provider === "opencode";

const toTextGenerationProvider = (provider: ProviderKind): TextGenerationProvider =>
  isTextGenerationProvider(provider) ? provider : "codex";

type TextGenerationModelSelection = Extract<ModelSelection, { provider: TextGenerationProvider }>;

export function normalizeTextGenerationModelSelection(
  selection: ModelSelection,
): TextGenerationModelSelection {
  switch (selection.provider) {
    case "codex":
    case "claudeAgent":
    case "githubCopilot":
    case "cursor":
    case "gemini":
      return selection;
    case "pi":
      return {
        provider: "codex",
        model: selection.model,
      };
    case "opencode":
      return selection;
  }
}

// ---------------------------------------------------------------------------
// Routing implementation
// ---------------------------------------------------------------------------

const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGen;
  const claude = yield* ClaudeTextGen;
  const gitHubCopilot = yield* GitHubCopilotTextGen;
  const cursor = yield* CursorTextGen;
  const gemini = yield* GeminiTextGen;
  const opencode = yield* OpenCodeTextGen;

  const route = (provider?: TextGenerationProvider): TextGenerationShape =>
    provider === "claudeAgent"
      ? claude
      : provider === "githubCopilot"
        ? gitHubCopilot
        : provider === "cursor"
          ? cursor
          : provider === "gemini"
            ? gemini
            : provider === "opencode"
              ? opencode
              : codex;

  return {
    generateCommitMessage: (input) => {
      const modelSelection = normalizeTextGenerationModelSelection(input.modelSelection);
      return route(toTextGenerationProvider(modelSelection.provider)).generateCommitMessage({
        ...input,
        modelSelection,
      });
    },
    generatePrContent: (input) => {
      const modelSelection = normalizeTextGenerationModelSelection(input.modelSelection);
      return route(toTextGenerationProvider(modelSelection.provider)).generatePrContent({
        ...input,
        modelSelection,
      });
    },
    generateBranchName: (input) => {
      const modelSelection = normalizeTextGenerationModelSelection(input.modelSelection);
      return route(toTextGenerationProvider(modelSelection.provider)).generateBranchName({
        ...input,
        modelSelection,
      });
    },
    generateThreadTitle: (input) => {
      const modelSelection = normalizeTextGenerationModelSelection(input.modelSelection);
      return route(toTextGenerationProvider(modelSelection.provider)).generateThreadTitle({
        ...input,
        modelSelection,
      });
    },
    generateWorkspaceSummary: (input) => {
      const modelSelection = normalizeTextGenerationModelSelection(input.modelSelection);
      return route(toTextGenerationProvider(modelSelection.provider)).generateWorkspaceSummary({
        ...input,
        modelSelection,
      });
    },
  } satisfies TextGenerationShape;
});

const InternalCodexLayer = Layer.effect(
  CodexTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(CodexTextGenerationLive));

const InternalClaudeLayer = Layer.effect(
  ClaudeTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(ClaudeTextGenerationLive));

const InternalGitHubCopilotLayer = Layer.effect(
  GitHubCopilotTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(GitHubCopilotTextGenerationLive));

const InternalCursorLayer = Layer.effect(
  CursorTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(CursorTextGenerationLive));

const InternalGeminiLayer = Layer.effect(
  GeminiTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(GeminiTextGenerationLive));

const InternalOpenCodeLayer = Layer.effect(
  OpenCodeTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(OpenCodeTextGenerationLive));

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(
  Layer.provide(InternalCodexLayer),
  Layer.provide(InternalClaudeLayer),
  Layer.provide(InternalGitHubCopilotLayer),
  Layer.provide(InternalCursorLayer),
  Layer.provide(InternalGeminiLayer),
  Layer.provide(InternalOpenCodeLayer),
);
