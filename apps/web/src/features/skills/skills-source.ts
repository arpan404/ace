/*
 * Skills from the daemon's plugin service (ADR 0014): the catalog (`plugins.list` and the paged
 * `plugins.catalog`), a component's source, availability per plugin, removal, and installing
 * through the mandatory trust review (`plugins.prepare`, `readReview`, `accept` or `cancel`).
 */
import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type {
  PluginComponent,
  PluginListing,
  PluginRequest,
  PluginResponse,
  PluginReviewEntry,
  PluginReviewSummary,
  ProviderKind,
} from "@ace/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import type { z } from "zod";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useRemovingPlugins } from "./plugin-removals.ts";
import { skillCatalog, type Skill } from "./skills-model.ts";

type Request = z.input<typeof PluginRequest>;
type Response<T extends PluginResponse["type"]> = Extract<PluginResponse, { type: T }>;

async function plugins<T extends PluginResponse["type"]>(
  client: ClientApi,
  request: Request,
  expected: T,
  signal?: AbortSignal,
): Promise<Response<T>> {
  const reply = await client.request({ type: "pluginRequest", request }, signal ? { signal } : {});
  const response = reply.response;
  if (!answers(response, expected)) throw new Error("The plugin service answered something else.");
  return response;
}

function answers<T extends PluginResponse["type"]>(
  response: PluginResponse,
  expected: T,
): response is Response<T> {
  return response.type === expected;
}

/** At most this many catalog pages (50 components each) are read. */
const maxPages = 20;

async function readCatalog(client: ClientApi, signal: AbortSignal): Promise<Skill[]> {
  const list = await plugins(client, { type: "plugins.list" }, "plugins.list", signal);
  const components: PluginComponent[] = [];
  let offset: number | undefined = 0;
  for (let page = 0; offset !== undefined && page < maxPages; page++) {
    const catalog: Response<"plugins.catalog"> = await plugins(
      client,
      { type: "plugins.catalog", offset, limit: 50 },
      "plugins.catalog",
      signal,
    );
    components.push(...catalog.components);
    offset = catalog.nextOffset;
  }
  // A daemon that predates `plugins.origins` simply doesn't say where plugins came from.
  const origins = await plugins(client, { type: "plugins.origins" }, "plugins.origins", signal)
    .then((reply) => reply.origins)
    .catch(() => []);
  return skillCatalog(list.installs, list.availability ?? [], components, origins);
}

const key = ["skills"] as const;

export function useSkills() {
  // Plugins whose removal is waiting out its Undo leave the catalog at once (plugin-removals.ts).
  const hiddenNow = useRemovingPlugins(useDaemonConnection().url);
  const select = useCallback(
    (skills: Skill[]) =>
      hiddenNow.size ? skills.filter((skill) => !hiddenNow.has(skill.plugin)) : skills,
    [hiddenNow],
  );
  return useDaemonQuery({ queryKey: key, read: readCatalog, select });
}

/** Read bounded source pages against one accepted hash, without cutting off at 64 KiB. */
export function useSkillSource(skill: Skill) {
  return useDaemonQuery({
    queryKey: [...key, "source", skill.plugin, skill.path ?? ""],
    enabled: skill.path !== undefined,
    read: async (client, signal) => {
      let offset = 0;
      let hash: string | undefined;
      const parts: string[] = [];
      for (let count = 0; count < 66; count++) {
        const page = await plugins(
          client,
          {
            type: "plugins.source",
            name: skill.plugin,
            path: skill.path ?? "",
            offset,
          },
          "plugins.source",
          signal,
        );
        if (
          (hash && hash !== page.hash) ||
          page.offset !== offset ||
          page.nextOffset > page.bytes ||
          page.bytes > 4 * 1024 ** 2
        )
          throw new Error("The source changed while loading. Try again.");
        hash = page.hash;
        parts.push(page.text);
        if (page.nextOffset >= page.bytes) return { text: parts.join(""), hash, bytes: page.bytes };
        if (page.nextOffset <= offset) break;
        offset = page.nextOffset;
      }
      throw new Error("This source is too large to open. Open it in your editor.");
    },
  });
}

export function useEditPlugin() {
  const client = useClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      path: string;
      expectedHash: string;
      text: string;
      signal?: AbortSignal;
    }) => {
      const { signal, ...request } = input;
      return ownReview(client, { type: "plugins.edit", ...request }, signal);
    },
  });
}

function usePluginMutation<T, R>(run: (client: ClientApi, input: T) => Promise<R>) {
  const client = useClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => run(client, input),
    // Keep controls pending until the catalog reflects the saved policy.
    onSuccess: () => queries.invalidateQueries({ queryKey: key }),
  });
}

/** Save availability, then read the effective catalog with both policies applied. */
export function useSetAvailability() {
  return usePluginMutation(
    async (
      client,
      input: {
        plugin: string;
        skill?: string | undefined;
        enabled: boolean;
        providers: readonly ProviderKind[];
      },
    ) =>
      input.skill
        ? plugins(
            client,
            {
              type: "plugins.skillAvailability",
              plugin: input.plugin,
              name: input.skill,
              enabled: input.enabled,
              providers: [...input.providers],
            },
            "plugins.skillAvailability",
          )
        : plugins(
            client,
            {
              type: "plugins.availability",
              name: input.plugin,
              enabled: input.enabled,
              providers: [...input.providers],
            },
            "plugins.availability",
          ),
  );
}

/**
 * Remove a plugin on the daemon, then read the catalog again. A plain function, not a mutation
 * hook: it runs once Undo has gone, usually after the page that asked has closed.
 */
export function useRemovePluginNow(): (name: string) => Promise<void> {
  const client = useClient();
  const queries = useQueryClient();
  return useCallback(
    async (name: string) => {
      await plugins(client, { type: "plugins.remove", name }, "plugins.removed");
      await queries.invalidateQueries({ queryKey: key });
    },
    [client, queries],
  );
}

export interface PreparedPlugin {
  review: PluginReviewSummary;
  /** What the plugin runs once enabled: hooks, MCP servers, remote endpoints, diagnostics. */
  entries: readonly PluginReviewEntry[];
}

/** Every page of a review: what the plugin runs (the daemon caps one review at 1,024 entries). */
async function readReview(
  client: ClientApi,
  first: Response<"plugins.review">["review"],
): Promise<PreparedPlugin> {
  const entries: PluginReviewEntry[] = [];
  let offset: number | undefined = 0;
  let review: PluginReviewSummary | undefined;
  while (offset !== undefined) {
    const page: Response<"plugins.reviewPage"> = await plugins(
      client,
      { type: "plugins.readReview", id: first.id, offset },
      "plugins.reviewPage",
    );
    review = page.review;
    entries.push(...page.entries);
    offset = page.nextOffset;
  }
  return { review: review ?? summary(first), entries };
}

/** Thrown when the person stopped waiting; the review the daemon made was cancelled. */
export class AbandonedReview extends Error {
  constructor() {
    super("Stopped");
    this.name = "AbandonedReview";
  }
}

/**
 * Ask for a review and own what comes back. The daemon keeps every review it makes until it is
 * accepted or cancelled (at most 32 at once), so the reply is always waited for, even after
 * Stop: a review nobody wants any more, or whose pages couldn't be read, is cancelled.
 */
async function ownReview(
  client: ClientApi,
  request: Request,
  stopped: AbortSignal | undefined,
): Promise<PreparedPlugin> {
  const made = await plugins(client, request, "plugins.review");
  const drop = () =>
    void plugins(client, { type: "plugins.cancel", id: made.review.id }, "plugins.cancelled").catch(
      () => {},
    );
  if (stopped?.aborted) {
    drop();
    throw new AbandonedReview();
  }
  try {
    const prepared = await readReview(client, made.review);
    if (stopped?.aborted) {
      drop();
      throw new AbandonedReview();
    }
    return prepared;
  } catch (error) {
    if (!(error instanceof AbandonedReview)) drop();
    throw error;
  }
}

/**
 * Fetch a plugin from its repository and pin it for review; nothing runs until accepted.
 * `signal` is Stop: the dialog moves on at once, and the review, when it arrives, is cancelled.
 */
export function usePreparePlugin() {
  const client = useClient();
  return useMutation({
    mutationFn: (input: {
      repository: string;
      ref: string;
      name: string;
      signal?: AbortSignal;
    }) => {
      const { signal, ...request } = input;
      return ownReview(client, { type: "plugins.prepare", ...request }, signal);
    },
  });
}

/** What a repository's marketplace offers, and the ref it read (the remote's HEAD by default). */
export function useMarketplace() {
  const client = useClient();
  return useMutation({
    mutationFn: async (input: {
      repository: string;
      ref?: string | undefined;
      signal?: AbortSignal;
    }): Promise<{ ref: string; plugins: readonly PluginListing[] }> => {
      const reply = await plugins(
        client,
        {
          type: "plugins.marketplace",
          repository: input.repository,
          ...(input.ref ? { ref: input.ref } : {}),
        },
        "plugins.marketplace",
        input.signal,
      );
      return { ref: reply.ref, plugins: reply.plugins };
    },
  });
}

/** Fetch the plugin's repository again at its ref and pin what's there now, for review. */
export function useUpdatePlugin() {
  const client = useClient();
  return useMutation({
    mutationFn: (input: { plugin: string; signal?: AbortSignal }) =>
      ownReview(client, { type: "plugins.update", name: input.plugin }, input.signal),
  });
}

function summary(review: Response<"plugins.review">["review"]): PluginReviewSummary {
  const { executions, unsupported, ...rest } = review;
  return { ...rest, executionCount: executions.length, unsupportedCount: unsupported.length };
}

/** Accept the reviewed pin: the daemon installs exactly the commit and hash shown. */
export function useAcceptPlugin() {
  return usePluginMutation((client, review: PluginReviewSummary) =>
    plugins(
      client,
      { type: "plugins.accept", id: review.id, commit: review.commit, hash: review.hash },
      "plugins.installed",
    ),
  );
}

export function useCancelReview() {
  return usePluginMutation((client, id: string) =>
    plugins(client, { type: "plugins.cancel", id }, "plugins.cancelled"),
  );
}
