import {
  SourceControlDraft,
  type SourceControlContext,
  type SourceControlDraftInput,
  type SourceControlSelection,
  type ThreadDetails,
} from "@ace/protocol";

export class FakeSourceControlDrafts {
  private pending = new Map<string, AbortController>();
  generate: (
    input: SourceControlDraftInput,
    context: SourceControlContext,
    signal: AbortSignal,
  ) => Promise<SourceControlDraft> = async (_input, context) => ({
    subject: "Update selected changes",
    body: context.paths.map((path) => `- Update ${path}`).join("\n"),
  });
  async context(
    selection: SourceControlSelection,
    details: ThreadDetails | undefined,
    paths: readonly string[],
    patch: string,
  ): Promise<SourceControlContext> {
    const head = details?.head ?? null;
    const bytes = new TextEncoder().encode(JSON.stringify({ selection, head, patch, paths }));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return {
      fingerprint,
      head,
      base: selection.kind === "pr" ? "a".repeat(40) : null,
      paths: [...paths],
      patch: patch.slice(0, 65536),
      truncated: patch.length > 65536,
      conventions: [],
      recentCommits: "",
    };
  }
  cancel(id: string) {
    this.pending.get(id)?.abort();
  }
  async draft(input: SourceControlDraftInput, context: SourceControlContext) {
    if (input.fingerprint !== context.fingerprint) throw new Error("draft_changes_moved");
    const controller = new AbortController();
    this.pending.set(input.generationId, controller);
    try {
      const cancelled = new Promise<never>((_resolve, reject) =>
        controller.signal.addEventListener("abort", () => reject(new Error("draft_cancelled")), {
          once: true,
        }),
      );
      return SourceControlDraft.parse(
        await Promise.race([this.generate(input, context, controller.signal), cancelled]),
      );
    } finally {
      this.pending.delete(input.generationId);
    }
  }
}
