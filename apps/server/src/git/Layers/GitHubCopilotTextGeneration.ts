import { Effect, Layer, Schema } from "effect";

import { approveAll } from "@github/copilot-sdk";
import {
  type ChatAttachment,
  type GitHubCopilotModelOptions,
  TextGenerationError,
} from "@ace/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@ace/shared/git";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  createGitHubCopilotClient,
  normalizeGitHubCopilotModelOptionsForModel,
} from "../../provider/githubCopilotSdk.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "../Utils.ts";

const GITHUB_COPILOT_TIMEOUT_MS = 180_000;

function extractJsonText(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return raw.trim();
}

const makeGitHubCopilotTextGeneration = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;

  const materializeAttachments = (attachments?: ReadonlyArray<ChatAttachment>) =>
    (attachments ?? [])
      .map((attachment) => {
        const filePath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!filePath) {
          return null;
        }
        return {
          type: "file" as const,
          path: filePath,
          displayName: attachment.name,
        };
      })
      .filter(
        (attachment): attachment is { type: "file"; path: string; displayName: string } =>
          attachment !== null,
      );

  const runGitHubCopilotJson = Effect.fn("runGitHubCopilotJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema,
    modelSelection,
    attachments,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchema: S;
    modelSelection: {
      provider: "githubCopilot";
      model: string;
      options?: GitHubCopilotModelOptions | undefined;
    };
    attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const settings = yield* serverSettingsService.getSettings.pipe(
      Effect.map((value) => value.providers.githubCopilot),
      Effect.mapError((cause) =>
        normalizeCliError(
          "copilot",
          operation,
          cause,
          "Failed to load GitHub Copilot CLI settings",
        ),
      ),
    );

    const jsonPrompt = `${prompt}\n\nReturn only valid JSON matching this schema:\n${JSON.stringify(
      toJsonSchemaObject(outputSchema),
      null,
      2,
    )}`;
    const imageAttachments = materializeAttachments(attachments);

    return yield* Effect.tryPromise(async () => {
      const trimmedCliUrl = settings.cliUrl.trim();
      const client = await createGitHubCopilotClient(
        settings.binaryPath,
        trimmedCliUrl.length > 0 ? { cliUrl: trimmedCliUrl } : undefined,
      );
      try {
        const availableModels = await client.listModels();
        const normalizedModelOptions = normalizeGitHubCopilotModelOptionsForModel(
          availableModels.find((model) => model.id === modelSelection.model),
          modelSelection.options,
        );
        const session = await client.createSession({
          model: modelSelection.model,
          ...(normalizedModelOptions?.reasoningEffort
            ? { reasoningEffort: normalizedModelOptions.reasoningEffort }
            : {}),
          onPermissionRequest: approveAll,
          workingDirectory: cwd,
          availableTools: [],
        });
        try {
          const response = await session.sendAndWait(
            {
              prompt: jsonPrompt,
              ...(imageAttachments.length > 0 ? { attachments: imageAttachments } : {}),
            },
            GITHUB_COPILOT_TIMEOUT_MS,
          );
          const content = response?.data.content;
          if (typeof content !== "string" || content.trim().length === 0) {
            throw new TextGenerationError({
              operation,
              detail: "GitHub Copilot returned an empty response.",
            });
          }
          return extractJsonText(content);
        } finally {
          await session.disconnect();
        }
      } finally {
        await client.stop();
      }
    }).pipe(
      Effect.flatMap((rawJson) =>
        Schema.decodeEffect(Schema.fromJsonString(outputSchema))(rawJson),
      ),
      Effect.mapError((cause) =>
        normalizeCliError("copilot", operation, cause, "GitHub Copilot text generation failed"),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "GitHubCopilotTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    if (input.modelSelection.provider !== "githubCopilot") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runGitHubCopilotJson({
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
    "GitHubCopilotTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    if (input.modelSelection.provider !== "githubCopilot") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runGitHubCopilotJson({
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
    "GitHubCopilotTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "githubCopilot") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runGitHubCopilotJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchema,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
    });

    return {
      branch: sanitizeFeatureBranchName(sanitizeBranchFragment(generated.branch)),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "GitHubCopilotTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "githubCopilot") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runGitHubCopilotJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchema,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const GitHubCopilotTextGenerationLive = Layer.effect(
  TextGeneration,
  makeGitHubCopilotTextGeneration,
);
