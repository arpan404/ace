import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  PromptFileOperation,
  type PromptFile,
  type PromptFileResult,
  type PromptFileScope,
} from "@ace/protocol";
import { parseMarkdown } from "./parse.ts";
import { SecureCommandIo } from "./secure-io.ts";
import type { DiscoveryRoot } from "./roots.ts";

export interface PromptFilesOptions {
  globalRoot: string;
  projectRoot(workspaceId: string): string | undefined;
  id(): string;
}
/** Bounded prompt reads and serialized writes using discovery's pinned filesystem descriptors. */
export class PromptFiles {
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly options: PromptFilesOptions;
  constructor(options: PromptFilesOptions) {
    this.options = options;
  }
  close(): void {
    this.closed = true;
  }
  async request(operation: unknown): Promise<PromptFileResult> {
    if (this.closed || this.pending >= 8)
      return {
        kind: "error",
        code: "unavailable",
        message: "Prompt files are busy. Try again in a moment.",
      };
    const parsed = PromptFileOperation.safeParse(operation);
    if (!parsed.success)
      return { kind: "error", code: "unavailable", message: "Choose a valid prompt file." };
    this.pending++;
    const result = this.tail
      .then(() => this.perform(parsed.data))
      .finally(() => {
        this.pending--;
      });
    this.tail = result.catch(() => {});
    return result;
  }
  private root(scope: PromptFileScope): DiscoveryRoot {
    const trustedRoot =
      scope.kind === "global"
        ? this.options.globalRoot
        : this.options.projectRoot(scope.workspaceId);
    if (!trustedRoot) throw new Error("prompt_not_found");
    return {
      path: join(trustedRoot, scope.kind === "global" ? "prompts" : ".ace/prompts"),
      trustedRoot,
      format: "library",
      scope: scope.kind === "global" ? "user" : "workspace",
    };
  }
  private metadata(scope: PromptFileScope, name: string, text: string): PromptFile {
    const parsed = parseMarkdown(text, {
      source: name,
      name: name.slice(0, -3),
      format: "library",
      scope: scope.kind === "global" ? "user" : "workspace",
    });
    return {
      scope,
      name,
      title: parsed.commands[0]?.name ?? name.slice(0, -3).slice(0, 128),
      description: parsed.commands[0]?.description ?? "",
      diagnostics: parsed.diagnostics,
    };
  }
  private async perform(
    op: import("@ace/protocol").PromptFileOperation,
  ): Promise<PromptFileResult> {
    const io = new SecureCommandIo();
    try {
      if (op.op === "list") {
        const files: PromptFile[] = [];
        const scopes: PromptFileScope[] = [
          { kind: "global" },
          ...(op.workspaceId ? [{ kind: "project" as const, workspaceId: op.workspaceId }] : []),
        ];
        for (const scope of scopes) {
          const root = this.root(scope);
          const dir = await io.directory(root, root.path).catch(() => undefined);
          if (!dir) continue;
          try {
            for (let count = 0; count < 512 && files.length < 256; count++) {
              const name = await dir.read();
              if (name === undefined) break;
              if (name.length > 132 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md$/.test(name)) continue;
              const data = await io.read(root, join(root.path, name)).catch(() => undefined);
              files.push(
                data
                  ? this.metadata(scope, name, data.text)
                  : {
                      scope,
                      name,
                      title: name.slice(0, -3).slice(0, 128),
                      description: "",
                      diagnostics: [
                        {
                          source: name,
                          message: "This file couldn't be read. Check its size and permissions.",
                        },
                      ],
                    },
              );
            }
          } finally {
            await dir.close();
          }
        }
        return { kind: "list", files: files.toSorted((a, b) => a.name.localeCompare(b.name)) };
      }
      const root = this.root(op.scope),
        path = join(root.path, op.name);
      if (op.op === "write")
        await io.writePrompt(
          root,
          path,
          op.text,
          op.expectedRevision,
          `.prompt-${this.options.id()}`,
        );
      const data = await io.read(root, path);
      return {
        kind: "file",
        file: this.metadata(op.scope, op.name, data.text),
        text: data.text,
        revision: createHash("sha256").update(data.text).digest("hex"),
      };
    } catch (error) {
      const code =
        error instanceof Error && error.message === "prompt_conflict"
          ? "conflict"
          : error instanceof Error && error.message === "prompt_limit"
            ? "limit"
            : "unavailable";
      return {
        kind: "error",
        code,
        message:
          code === "conflict"
            ? "This prompt changed elsewhere. Reload it before saving."
            : code === "limit"
              ? "Prompt files can be up to 64 KB. Shorten this prompt and save again."
              : "Couldn't open or save this prompt. Check its permissions and try again.",
      };
    } finally {
      await io.close();
    }
  }
}
