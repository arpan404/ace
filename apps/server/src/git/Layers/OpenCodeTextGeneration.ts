/**
 * OpenCode-backed git text generation via HTTP SDK (`opencode serve`) and structured JSON output.
 *
 * @module OpenCodeTextGeneration
 */
import type { ModelSelection } from "@ace/contracts";
import { TextGenerationError } from "@ace/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@ace/shared/git";
import { resolveProviderSettings } from "@ace/shared/providerInstances";
import { Effect, Layer, Option, Schema } from "effect";

import { startOpenCodeServerIsolated } from "../../provider/opencodeRuntime.ts";
import {
  createOpenCodeSdkClient,
  extractTextPartsFromPromptResponse,
  resolveOpenCodeModelForPrompt,
} from "../../provider/opencodeSdk.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
  buildWorkspaceSummaryPrompt,
} from "../Prompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  sanitizeWorkspaceSummaryHeadline,
  sanitizeWorkspaceSummaryKeyChanges,
  sanitizeWorkspaceSummaryParagraph,
  sanitizeWorkspaceSummaryRisks,
  toJsonSchemaObject,
} from "../Utils.ts";

const OPENCODE_GIT_TIMEOUT_MS = 180_000;

function extractJsonText(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return raw.trim();
}

const makeOpenCodeTextGeneration = Effect.gen(function* () {
  const serverSettingsService = yield* ServerSettingsService;

  const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateWorkspaceSummary";
    cwd: string;
    prompt: string;
    outputSchema: S;
    modelSelection: Extract<ModelSelection, { provider: "opencode" }>;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const settings = yield* serverSettingsService.getSettings.pipe(
      Effect.mapError(
        (e) =>
          new TextGenerationError({
            operation,
            detail: e.message,
            cause: e,
          }),
      ),
    );
    const openCodeSettings = resolveProviderSettings(
      settings,
      "opencode",
      modelSelection.providerInstanceId,
    );
    const binaryPath = openCodeSettings.binaryPath;

    const rawPayload = yield* Effect.tryPromise({
      try: async () => {
        const server = await startOpenCodeServerIsolated(binaryPath, {
          ...openCodeSettings.launchEnv,
          ...(openCodeSettings.configDir
            ? { OPENCODE_CONFIG_DIR: openCodeSettings.configDir }
            : {}),
        });
        try {
          const client = createOpenCodeSdkClient({
            baseUrl: server.url,
            directory: cwd,
          });

          const listed = await client.provider.list();
          if (listed.error) {
            throw new Error("Failed to list OpenCode providers for defaults.");
          }
          const body = listed.data as { default?: Record<string, string> } | undefined;
          const defaults = body?.default ?? {};

          const model = resolveOpenCodeModelForPrompt({
            modelSlug: modelSelection.model,
            defaults,
          });

          const created = await client.session.create({
            directory: cwd,
            title: `ace-${operation}`,
          });
          if (created.error || !created.data) {
            throw new Error("Failed to create OpenCode session for text generation.");
          }
          const sessionId = created.data.id;

          try {
            const jsonSchema = toJsonSchemaObject(outputSchema);
            const result = await client.session.prompt({
              sessionID: sessionId,
              directory: cwd,
              model,
              format: {
                type: "json_schema",
                schema: jsonSchema as Record<string, unknown>,
              },
              parts: [{ type: "text", text: prompt }],
            });

            if (result.error || !result.data) {
              throw new Error("OpenCode prompt failed for text generation.");
            }

            const text = extractTextPartsFromPromptResponse(result.data.parts);
            const jsonText = extractJsonText(text);
            return JSON.parse(jsonText) as unknown;
          } finally {
            await client.session.delete({
              sessionID: sessionId,
              directory: cwd,
            });
          }
        } finally {
          await server.close();
        }
      },
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(
      Effect.timeoutOption(OPENCODE_GIT_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "OpenCode text generation timed out.",
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    return yield* Schema.decodeEffect(outputSchema)(rawPayload).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "OpenCode returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "OpenCodeTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runOpenCodeJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "OpenCodeTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runOpenCodeJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "OpenCodeTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
    });

    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runOpenCodeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "OpenCodeTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
    });

    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runOpenCodeJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  const generateWorkspaceSummary: TextGenerationShape["generateWorkspaceSummary"] = Effect.fn(
    "OpenCodeTextGeneration.generateWorkspaceSummary",
  )(function* (input) {
    const { prompt, outputSchema } = buildWorkspaceSummaryPrompt({
      turnState: input.turnState,
      userRequests: input.userRequests,
      assistantWork: input.assistantWork,
      workingTreeSummary: input.workingTreeSummary,
      workingTreeDiff: input.workingTreeDiff,
    });

    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generateWorkspaceSummary",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runOpenCodeJson({
      operation: "generateWorkspaceSummary",
      cwd: input.cwd,
      prompt,
      outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      headline: sanitizeWorkspaceSummaryHeadline(generated.headline),
      summary: sanitizeWorkspaceSummaryParagraph(generated.summary),
      keyChanges: sanitizeWorkspaceSummaryKeyChanges(generated.keyChanges),
      risks: sanitizeWorkspaceSummaryRisks(generated.risks),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateWorkspaceSummary,
  } satisfies TextGenerationShape;
});

export const OpenCodeTextGenerationLive = Layer.effect(TextGeneration, makeOpenCodeTextGeneration);
