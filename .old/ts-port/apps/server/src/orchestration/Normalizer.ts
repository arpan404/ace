import { Effect } from "effect";
import {
  type ClientOrchestrationCommand,
  OrchestrationDispatchCommandError,
  type OrchestrationCommand,
} from "@ace/contracts";

import { WorkspacePaths } from "../workspace/Services/WorkspacePaths";
import { normalizeUploadChatAttachments } from "./attachmentNormalization";

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const workspacePaths = yield* WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (
      workspaceRoot: string,
      options?: { readonly createIfMissing?: boolean },
    ) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot, options).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    if (command.type === "project.create") {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(
          command.workspaceRoot,
          command.createWorkspaceRootIfMissing === undefined
            ? undefined
            : { createIfMissing: command.createWorkspaceRootIfMissing },
        ),
      } satisfies OrchestrationCommand;
    }

    if (command.type === "project.meta.update" && command.workspaceRoot !== undefined) {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (command.type !== "thread.turn.start") {
      return command as OrchestrationCommand;
    }

    const normalizedAttachments = yield* normalizeUploadChatAttachments({
      threadId: command.threadId,
      attachments: command.message.attachments,
    });

    return {
      ...command,
      message: {
        ...command.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
