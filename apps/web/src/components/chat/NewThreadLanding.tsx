import { type ModelSelection, type ProjectId, type ThreadId } from "@ace/contracts";
import { PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { DEFAULT_THREAD_TITLE } from "~/lib/chat/chatView";
import { selectThreadIdsByProjectId, useStore } from "~/store";
import { useSidebarThreadSummariesByProjectId } from "~/storeSelectors";
import { type ChatMessage, type Thread } from "~/types";

export interface NewThreadRecommendedPrompt {
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
}

const MAX_RECOMMENDED_PROMPTS = 3;
const EMPTY_RECOMMENDED_PROMPTS: readonly NewThreadRecommendedPrompt[] = [];
const EMPTY_PROJECT_THREADS: readonly Thread[] = [];
const RECOMMENDATION_CACHE_STORAGE_PREFIX = "ace:new-thread-recommendations:v2:";
const RECOMMENDATION_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const RECOMMENDATION_GENERATION_FAILURE_COOLDOWN_MS = 5 * 60 * 1_000;
const MAX_RECOMMENDATION_CONTEXT_CHARS = 2_400;

interface RecommendationContextTurn {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly latestUserMessage: string;
  readonly latestAssistantMessage: string;
  readonly updatedAt: string;
}

interface CachedRecommendationPayload {
  readonly fingerprint: string;
  readonly generatedAt: number;
  readonly recommendations: ReadonlyArray<NewThreadRecommendedPrompt>;
}

const recommendationRequestsByFingerprint = new Map<
  string,
  Promise<ReadonlyArray<NewThreadRecommendedPrompt>>
>();
const recommendationFailureCooldownByFingerprint = new Map<string, number>();

function trimThreadTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ");
}

function resolveThreadInteractionTimestamp(thread: {
  readonly latestUserMessageAt: string | null;
  readonly updatedAt?: string | undefined;
  readonly createdAt: string;
}): number {
  const value = thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function clipRecommendationContext(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= MAX_RECOMMENDATION_CONTEXT_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_RECOMMENDATION_CONTEXT_CHARS).trimEnd()}...`;
}

function latestMessageText(
  messages: ReadonlyArray<ChatMessage>,
  role: ChatMessage["role"],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== role) {
      continue;
    }
    const text = clipRecommendationContext(message.text);
    if (text.length > 0) {
      return text;
    }
  }
  return "";
}

function selectLatestTurnMessages(thread: Thread): ReadonlyArray<ChatMessage> {
  const latestTurnId = thread.latestTurn?.turnId ?? null;
  if (!latestTurnId) {
    return thread.messages;
  }
  const latestTurnMessages = thread.messages.filter((message) => message.turnId === latestTurnId);
  return latestTurnMessages.length > 0 ? latestTurnMessages : thread.messages;
}

function isCachedRecommendationPayload(value: unknown): value is CachedRecommendationPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CachedRecommendationPayload>;
  return (
    typeof candidate.fingerprint === "string" &&
    typeof candidate.generatedAt === "number" &&
    Array.isArray(candidate.recommendations) &&
    normalizeRecommendedPrompts(candidate.recommendations).length ===
      candidate.recommendations.length
  );
}

function isUsefulRecommendedPrompt(value: unknown): value is NewThreadRecommendedPrompt {
  if (!value || typeof value !== "object") {
    return false;
  }

  const recommendation = value as Partial<NewThreadRecommendedPrompt>;
  if (
    typeof recommendation.title !== "string" ||
    typeof recommendation.description !== "string" ||
    typeof recommendation.prompt !== "string"
  ) {
    return false;
  }

  const title = recommendation.title.trim();
  const description = recommendation.description.trim();
  const prompt = recommendation.prompt.trim();
  if (title.length < 4 || description.length < 12 || prompt.length < 20) {
    return false;
  }

  const joined = `${title} ${description} ${prompt}`.toLowerCase();
  const blockedFragments = [
    "start a task",
    "continue latest work",
    "continue recent work",
    "continue with the next useful",
    "pick up from the recent",
    "pick up from the latest",
    "recent turns only contain greetings",
    "state the coding task clearly",
  ];
  return !blockedFragments.some((fragment) => joined.includes(fragment));
}

function normalizeRecommendedPrompts(
  recommendations: ReadonlyArray<unknown>,
): ReadonlyArray<NewThreadRecommendedPrompt> {
  const seenPrompts = new Set<string>();
  const normalized: NewThreadRecommendedPrompt[] = [];
  for (const recommendation of recommendations) {
    if (!isUsefulRecommendedPrompt(recommendation)) {
      continue;
    }
    const prompt = recommendation.prompt.trim().replace(/\s+/g, " ");
    if (seenPrompts.has(prompt)) {
      continue;
    }
    seenPrompts.add(prompt);
    normalized.push({
      title: recommendation.title.trim().replace(/\s+/g, " "),
      description: recommendation.description.trim().replace(/\s+/g, " "),
      prompt,
    });
  }

  return normalized.length === MAX_RECOMMENDED_PROMPTS ? normalized : EMPTY_RECOMMENDED_PROMPTS;
}

function readCachedRecommendations(projectId: ProjectId): CachedRecommendationPayload | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(`${RECOMMENDATION_CACHE_STORAGE_PREFIX}${projectId}`);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return isCachedRecommendationPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedRecommendations(projectId: ProjectId, payload: CachedRecommendationPayload) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      `${RECOMMENDATION_CACHE_STORAGE_PREFIX}${projectId}`,
      JSON.stringify(payload),
    );
  } catch {
    // Best-effort cache; generation should still work when storage is unavailable.
  }
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function buildRecommendationFingerprint(input: {
  readonly modelSelection: ModelSelection;
  readonly turns: ReadonlyArray<RecommendationContextTurn>;
}): string {
  return hashString(JSON.stringify({ model: input.modelSelection, turns: input.turns }));
}

function useProjectThreads(projectId: ProjectId | null): ReadonlyArray<Thread> {
  const threadIdsSelector = useMemo(() => selectThreadIdsByProjectId(projectId), [projectId]);
  const threadIds = useStore(threadIdsSelector);
  const threadsById = useStore((state) => state.threadsById);
  const threads = useStore((state) => state.threads);

  return useMemo(() => {
    if (!projectId || threadIds.length === 0) {
      return EMPTY_PROJECT_THREADS;
    }

    const lookup =
      threadsById ?? Object.fromEntries(threads.map((thread) => [thread.id, thread] as const));
    const projectThreads: Thread[] = [];
    for (const threadId of threadIds) {
      const thread = lookup[threadId];
      if (thread) {
        projectThreads.push(thread);
      }
    }
    return projectThreads.length > 0 ? projectThreads : EMPTY_PROJECT_THREADS;
  }, [projectId, threadIds, threads, threadsById]);
}

function buildRecommendationContextTurns(input: {
  readonly projectThreads: ReadonlyArray<Thread>;
  readonly sidebarThreads: ReturnType<typeof useSidebarThreadSummariesByProjectId>;
}): ReadonlyArray<RecommendationContextTurn> {
  const threadsById = new Map(input.projectThreads.map((thread) => [thread.id, thread]));
  const recentThreads = input.sidebarThreads.toSorted(
    (left, right) =>
      resolveThreadInteractionTimestamp(right) - resolveThreadInteractionTimestamp(left),
  );

  const turns: RecommendationContextTurn[] = [];
  for (const summary of recentThreads) {
    const thread = threadsById.get(summary.id);
    if (!thread || thread.archivedAt !== null) {
      continue;
    }
    const title = trimThreadTitle(thread.title);
    if (!title || title === DEFAULT_THREAD_TITLE) {
      continue;
    }

    const latestTurnMessages = selectLatestTurnMessages(thread);
    const latestUserMessage = latestMessageText(latestTurnMessages, "user");
    if (!latestUserMessage) {
      continue;
    }

    turns.push({
      threadId: thread.id,
      title,
      latestUserMessage,
      latestAssistantMessage: latestMessageText(latestTurnMessages, "assistant"),
      updatedAt: thread.updatedAt ?? summary.updatedAt ?? thread.createdAt,
    });

    if (turns.length >= MAX_RECOMMENDED_PROMPTS) {
      break;
    }
  }

  return turns;
}

function shouldRegenerateRecommendations(
  cached: CachedRecommendationPayload | null,
  fingerprint: string,
  now: number,
): boolean {
  if (!cached || cached.fingerprint !== fingerprint) {
    return true;
  }
  return now - cached.generatedAt >= RECOMMENDATION_CACHE_TTL_MS;
}

async function requestGeneratedRecommendations(input: {
  readonly cwd: string;
  readonly modelSelection: ModelSelection;
  readonly turns: ReadonlyArray<RecommendationContextTurn>;
  readonly fingerprint: string;
}): Promise<ReadonlyArray<NewThreadRecommendedPrompt>> {
  const existingRequest = recommendationRequestsByFingerprint.get(input.fingerprint);
  if (existingRequest) {
    return existingRequest;
  }

  const request = ensureNativeApi()
    .server.generateNewThreadRecommendations({
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      turns: input.turns,
    })
    .then((result) => result.recommendations);

  recommendationRequestsByFingerprint.set(input.fingerprint, request);
  try {
    return await request;
  } finally {
    recommendationRequestsByFingerprint.delete(input.fingerprint);
  }
}

export function useNewThreadRecommendedPrompts(
  activeProjectId: ProjectId | null,
  activeProjectCwd: string | null,
  modelSelection: ModelSelection | null,
): ReadonlyArray<NewThreadRecommendedPrompt> {
  const allProjectThreads = useSidebarThreadSummariesByProjectId(activeProjectId);
  const projectThreads = useProjectThreads(activeProjectId);
  const contextTurns = useMemo(
    () =>
      buildRecommendationContextTurns({
        projectThreads,
        sidebarThreads: allProjectThreads,
      }),
    [allProjectThreads, projectThreads],
  );
  const fingerprint = useMemo(() => {
    if (!modelSelection || contextTurns.length === 0) {
      return null;
    }
    return buildRecommendationFingerprint({ modelSelection, turns: contextTurns });
  }, [contextTurns, modelSelection]);
  const [recommendations, setRecommendations] =
    useState<ReadonlyArray<NewThreadRecommendedPrompt>>(EMPTY_RECOMMENDED_PROMPTS);

  useEffect(() => {
    if (!activeProjectId || !activeProjectCwd || !modelSelection || !fingerprint) {
      setRecommendations(EMPTY_RECOMMENDED_PROMPTS);
      return;
    }

    const now = Date.now();
    const cached = readCachedRecommendations(activeProjectId);
    if (cached?.fingerprint === fingerprint) {
      setRecommendations(normalizeRecommendedPrompts(cached.recommendations));
    } else {
      setRecommendations(EMPTY_RECOMMENDED_PROMPTS);
    }

    if (!shouldRegenerateRecommendations(cached, fingerprint, now)) {
      return;
    }

    const cooldownUntil = recommendationFailureCooldownByFingerprint.get(fingerprint) ?? 0;
    if (cooldownUntil > now) {
      return;
    }

    let cancelled = false;
    void requestGeneratedRecommendations({
      cwd: activeProjectCwd,
      modelSelection,
      turns: contextTurns,
      fingerprint,
    })
      .then((generatedRecommendations) => {
        if (cancelled) {
          return;
        }
        const normalizedRecommendations = normalizeRecommendedPrompts(generatedRecommendations);
        const payload: CachedRecommendationPayload = {
          fingerprint,
          generatedAt: Date.now(),
          recommendations: normalizedRecommendations,
        };
        writeCachedRecommendations(activeProjectId, payload);
        setRecommendations(normalizedRecommendations);
      })
      .catch(() => {
        recommendationFailureCooldownByFingerprint.set(
          fingerprint,
          Date.now() + RECOMMENDATION_GENERATION_FAILURE_COOLDOWN_MS,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectCwd, activeProjectId, contextTurns, fingerprint, modelSelection]);

  return recommendations;
}

interface NewThreadStartSurfaceProps {
  readonly branchControlNode: ReactNode;
  readonly composerNode: ReactNode;
  readonly contextControlsNode: ReactNode;
  readonly hasProjects: boolean;
  readonly quickActionsNode?: ReactNode;
  readonly recommendedPrompts: ReadonlyArray<NewThreadRecommendedPrompt>;
  readonly title: string;
  readonly onRecommendedPromptClick: (prompt: string) => void;
}

export function NewThreadStartSurface({
  branchControlNode,
  composerNode,
  contextControlsNode,
  hasProjects,
  quickActionsNode,
  recommendedPrompts,
  title,
  onRecommendedPromptClick,
}: NewThreadStartSurfaceProps) {
  return (
    <div className="new-thread-start-surface flex flex-1 flex-col items-center justify-center overflow-x-hidden overflow-y-auto px-4 py-8 sm:px-8 sm:py-12">
      <section className="flex w-full min-w-0 max-w-3xl flex-col items-center text-center">
        <h1 className="new-thread-start-title max-w-full text-balance font-medium text-foreground/92">
          {title}
        </h1>

        {hasProjects ? (
          <div className="new-thread-start-body flex w-full min-w-0 flex-col items-center">
            <div className="new-thread-start-composer w-full min-w-0 max-w-3xl text-left">
              {composerNode}

              <div className="new-thread-start-controls mt-2 flex min-h-8 w-full min-w-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 text-center">
                {contextControlsNode}
                {branchControlNode}
                {quickActionsNode}
              </div>
            </div>

            {recommendedPrompts.length > 0 ? (
              <div className="mt-10 w-full max-w-3xl border-t border-border/20 pt-3">
                <div className="flex w-full flex-col">
                  {recommendedPrompts.map((rec) => (
                    <button
                      key={`${rec.title}:${rec.prompt}`}
                      type="button"
                      onClick={() => onRecommendedPromptClick(rec.prompt)}
                      className="group flex min-h-14 w-full items-center border-b border-border/20 px-1 py-3 text-left transition-colors last:border-b-0 hover:bg-foreground/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-foreground/90 transition-colors group-hover:text-foreground">
                          {rec.title}
                        </span>
                        <span className="mt-0.5 block truncate text-[12px] leading-5 text-muted-foreground/70">
                          {rec.description}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-8 inline-flex items-center gap-2 rounded-[var(--control-radius)] border border-dashed border-border/50 px-4 py-2.5 text-sm text-muted-foreground">
            <PlusIcon className="size-4" />
            Use the Add project button in the sidebar.
          </div>
        )}
      </section>
    </div>
  );
}
