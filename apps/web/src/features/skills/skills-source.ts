/*
 * Skills from the daemon's plugin service (ADR 0014): the catalog (`plugins.list` and the paged
 * `plugins.catalog`), a component's source, availability per plugin, removal, and installing
 * through the mandatory trust review (`plugins.prepare`, `readReview`, `accept` or `cancel`).
 */
import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type {
  PluginComponent,
  PluginRequest,
  PluginResponse,
  PluginReviewEntry,
  PluginReviewSummary,
  ProviderKind,
} from "@ace/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
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
  return skillCatalog(list.installs, list.availability ?? [], components);
}

const key = ["skills"] as const;

export function useSkills() {
  return useDaemonQuery({ queryKey: key, read: readCatalog });
}

/** The first page (64 KiB) of a component's source, as accepted at install. */
export function useSkillSource(skill: Skill) {
  return useDaemonQuery({
    queryKey: [...key, "source", skill.plugin, skill.path ?? ""],
    enabled: skill.path !== undefined,
    read: async (client, signal) => {
      const page = await plugins(
        client,
        { type: "plugins.source", name: skill.plugin, path: skill.path ?? "" },
        "plugins.source",
        signal,
      );
      return { text: page.text, truncated: page.nextOffset < page.bytes };
    },
  });
}

function usePluginMutation<T, R>(run: (client: ClientApi, input: T) => Promise<R>) {
  const client = useClient();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => run(client, input),
    // Not awaited: the caller can move on (open the new plugin) while the catalog reloads.
    onSuccess: () => void queries.invalidateQueries({ queryKey: key }),
  });
}

/** Turn a plugin on or off, and choose which providers may load it. */
export function useSetAvailability() {
  return usePluginMutation(
    (client, input: { plugin: string; enabled: boolean; providers: readonly ProviderKind[] }) =>
      plugins(
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

export function useRemovePlugin() {
  return usePluginMutation((client, name: string) =>
    plugins(client, { type: "plugins.remove", name }, "plugins.removed"),
  );
}

export interface PreparedPlugin {
  review: PluginReviewSummary;
  /** What the plugin runs once enabled: hooks, MCP servers, remote endpoints, diagnostics. */
  entries: readonly PluginReviewEntry[];
}

/** Fetch a plugin from its repository and pin it for review; nothing runs until accepted. */
export function usePreparePlugin() {
  const client = useClient();
  return useMutation({
    mutationFn: async (input: { repository: string; ref: string; name: string }) => {
      const prepared = await plugins(
        client,
        { type: "plugins.prepare", ...input },
        "plugins.review",
      );
      const entries: PluginReviewEntry[] = [];
      let offset: number | undefined = 0;
      let review: PluginReviewSummary | undefined;
      // A review pages its executions; read them all (the daemon caps one review at 1,024).
      while (offset !== undefined) {
        const page: Response<"plugins.reviewPage"> = await plugins(
          client,
          { type: "plugins.readReview", id: prepared.review.id, offset },
          "plugins.reviewPage",
        );
        review = page.review;
        entries.push(...page.entries);
        offset = page.nextOffset;
      }
      return { review: review ?? summary(prepared.review), entries } satisfies PreparedPlugin;
    },
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
