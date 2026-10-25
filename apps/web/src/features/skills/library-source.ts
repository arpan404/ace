/*
 * The daemon's skill library (ADR 0103): every skill the person's agents read, merged across
 * agents, and the requests that change one. Clients send ids, never paths.
 */
import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type {
  SkillAgent,
  SkillEntry,
  SkillOperation,
  SkillResult,
  SkillUpdateReview,
  WorkspaceId,
} from "@ace/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

type Operation = z.input<typeof import("@ace/protocol").SkillOperation>;
type Result<K extends SkillResult["kind"]> = Extract<SkillResult, { kind: K }>;

/** A request the daemon refused, with its typed reason (`conflict`, `exists`, `read_only`…). */
export class SkillRequestError extends Error {
  readonly code: Result<"error">["code"];
  constructor(code: Result<"error">["code"], message: string) {
    super(message);
    this.name = "SkillRequestError";
    this.code = code;
  }
}

async function skills<K extends SkillResult["kind"]>(
  client: ClientApi,
  operation: Operation,
  expected: K,
  signal?: AbortSignal,
): Promise<Result<K>> {
  const reply = await client.request(
    { type: "skills.request", operation: operation as SkillOperation },
    signal ? { signal } : {},
  );
  const result = reply.result;
  if (result.kind === "error") throw new SkillRequestError(result.code, result.message);
  if (!answers(result, expected)) throw new Error("The skill library answered something else.");
  return result;
}

function answers<K extends SkillResult["kind"]>(
  result: SkillResult,
  expected: K,
): result is Result<K> {
  return result.kind === expected;
}

/**
 * Subscribe to the merged list (personal, plugin and built-in skills, plus the project's when one
 * is named). Each snapshot replaces the last; `failed` runs once when the list can't be read.
 */
export function watchLibrary(
  client: ClientApi,
  workspaceId: WorkspaceId | undefined,
  receive: (entries: readonly SkillEntry[], stale: boolean) => void,
  failed: () => void,
): () => void {
  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  let pushed = false;
  const stop = client.onMessage((message) => {
    if (message.type === "skills.changed" && message.requestId === requestId) {
      pushed = true;
      receive(message.entries, message.stale);
    }
  });
  void client
    .request(
      {
        type: "skills.request",
        operation: { op: "list", subscribe: true, ...(workspaceId ? { workspaceId } : {}) },
      },
      { requestId, signal: controller.signal },
    )
    .then(
      (reply) => {
        if (controller.signal.aborted || pushed) return;
        if (reply.result.kind === "list") receive(reply.result.entries, reply.result.stale);
        else failed();
      },
      () => {
        if (!controller.signal.aborted) failed();
      },
    );
  return () => {
    controller.abort();
    stop();
    try {
      if (client.state === "ready") client.send({ type: "skills.unsubscribe", requestId });
    } catch {
      // Disconnect can race the worker mirror; the closed socket owns its subscriptions.
    }
  };
}

const key = ["skills", "library"] as const;

/** A skill's SKILL.md as it is now, with the entry it belongs to (and its hash). */
export function useSkillFile(id: string, workspaceId: WorkspaceId | undefined, hash: string) {
  return useDaemonQuery({
    // The hash is in the key: an edit anywhere reads the new text.
    queryKey: [...key, "read", id, hash],
    read: async (client, signal) => {
      const reply = await skills(
        client,
        { op: "read", id, ...(workspaceId ? { workspaceId } : {}) },
        "skill",
        signal,
      );
      return { entry: reply.entry, text: reply.text };
    },
  });
}

/** How often each skill was used, and the last thread it was used in. */
export function useSkillUsage(id: string, workspaceId: WorkspaceId | undefined) {
  return useDaemonQuery({
    queryKey: [...key, "usage", id],
    read: async (client, signal) => {
      const reply = await skills(
        client,
        { op: "usage", ids: [id], ...(workspaceId ? { workspaceId } : {}) },
        "usage",
        signal,
      );
      return reply.usage.find((usage) => usage.id === id);
    },
  });
}

function useLibraryMutation<T, R>(run: (client: ClientApi, input: T) => Promise<R>) {
  const client = useClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => run(client, input),
    onSuccess: () => queries.invalidateQueries({ queryKey: key }),
  });
}

const at = (workspaceId: WorkspaceId | undefined) => (workspaceId ? { workspaceId } : {});

export interface CreateSkill {
  name: string;
  description: string;
  body: string;
  scope: { kind: "personal" } | { kind: "project"; workspaceId: WorkspaceId };
  agents: readonly SkillAgent[];
  manual: boolean;
}

export function useCreateSkill() {
  return useLibraryMutation(async (client, input: CreateSkill) => {
    const reply = await skills(
      client,
      { op: "create", ...input, agents: [...input.agents] },
      "skill",
    );
    return reply.entry;
  });
}

interface Target {
  id: string;
  workspaceId: WorkspaceId | undefined;
}

export function useEditSkill() {
  return useLibraryMutation(
    async (
      client,
      input: Target & { expectedHash: string; description: string; body: string; manual: boolean },
    ) => {
      const { workspaceId, ...rest } = input;
      return (await skills(client, { op: "edit", ...rest, ...at(workspaceId) }, "skill")).entry;
    },
  );
}

/** Add or remove agents; the reply names agents left in place and why. */
export function useSetSkillAgents() {
  return useLibraryMutation(
    async (client, input: Target & { agents: readonly SkillAgent[] }) =>
      skills(
        client,
        { op: "setAgents", id: input.id, agents: [...input.agents], ...at(input.workspaceId) },
        "skill",
      ),
  );
}

export function useDeleteSkill() {
  return useLibraryMutation(async (client, input: Target & { expectedHash: string }) =>
    skills(
      client,
      { op: "delete", id: input.id, expectedHash: input.expectedHash, ...at(input.workspaceId) },
      "deleted",
    ),
  );
}

/** Ask the skill's source whether a newer version exists. */
export function useCheckSkillUpdate() {
  const client = useClient();
  return useMutation({
    mutationFn: (input: Target) =>
      skills(client, { op: "checkUpdate", id: input.id, ...at(input.workspaceId) }, "updateStatus"),
  });
}

/** Fetch the newer version into staging and describe it for review; nothing changes yet. */
export function usePrepareSkillUpdate() {
  const client = useClient();
  return useMutation({
    mutationFn: async (input: Target): Promise<SkillUpdateReview> =>
      (
        await skills(
          client,
          { op: "prepareUpdate", id: input.id, ...at(input.workspaceId) },
          "updateReview",
        )
      ).review,
  });
}

export function useApplySkillUpdate() {
  return useLibraryMutation(
    async (client, input: Target & { reviewId: string; expectedHash: string }) =>
      (
        await skills(
          client,
          {
            op: "applyUpdate",
            id: input.id,
            reviewId: input.reviewId,
            expectedHash: input.expectedHash,
            ...at(input.workspaceId),
          },
          "skill",
        )
      ).entry,
  );
}

/** Drop a review nobody will apply; the daemon would otherwise keep it for half an hour. */
export function useCancelSkillUpdate() {
  const client = useClient();
  return useMutation({
    mutationFn: (reviewId: string) =>
      skills(client, { op: "cancelUpdate", reviewId }, "cancelled"),
  });
}
