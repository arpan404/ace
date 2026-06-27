import { type ModelSelection, type ProjectId, type ThreadId } from "@ace/contracts";
import { PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
const LEGACY_RECOMMENDATION_CACHE_STORAGE_PREFIXES = [
  "ace:new-thread-recommendations:v2:",
  "ace:new-thread-recommendations:v3:",
] as const;
const RECOMMENDATION_GENERATION_FAILURE_COOLDOWN_MS = 5 * 60 * 1_000;
const MAX_RECOMMENDATION_CONTEXT_CHARS = 2_400;

interface RecommendationContextTurn {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly latestUserMessage: string;
  readonly latestAssistantMessage: string;
  readonly updatedAt: string;
}

const recommendationRequestsByFingerprint = new Map<
  string,
  Promise<ReadonlyArray<NewThreadRecommendedPrompt>>
>();
const recommendationFailureCooldownByFingerprint = new Map<string, number>();
let legacyBrowserRecommendationCacheCleaned = false;

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

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function cleanupLegacyBrowserRecommendationCache() {
  if (typeof window === "undefined") {
    return;
  }
  if (legacyBrowserRecommendationCacheCleaned) {
    return;
  }
  legacyBrowserRecommendationCacheCleaned = true;
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (LEGACY_RECOMMENDATION_CACHE_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Legacy browser cache cleanup is best-effort; the backend cache is authoritative.
  }
}

function useProjectThreads(projectId: ProjectId | null): ReadonlyArray<Thread> {
  const threadIds = useStore(selectThreadIdsByProjectId(projectId));
  const threadsById = useStore((state) => state.threadsById);
  const threads = useStore((state) => state.threads);

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
  const contextTurns = buildRecommendationContextTurns({
    projectThreads,
    sidebarThreads: allProjectThreads,
  });
  const contextTurnsSignature = JSON.stringify(contextTurns);
  const modelSelectionSignature = modelSelection ? JSON.stringify(modelSelection) : null;
  const fingerprint =
    modelSelectionSignature && activeProjectCwd
      ? hashString(
          JSON.stringify({
            cwd: activeProjectCwd,
            model: modelSelectionSignature,
            turns: contextTurnsSignature,
          }),
        )
      : null;
  const requestKey = activeProjectId && fingerprint ? `${activeProjectId}:${fingerprint}` : null;
  const lastCompletedRequestKeyRef = useRef<string | null>(null);
  const [generatedRecommendations, setGeneratedRecommendations] = useState<{
    readonly activeProjectId: ProjectId;
    readonly activeProjectCwd: string;
    readonly contextTurnsSignature: string;
    readonly requestKey: string;
    readonly recommendations: ReadonlyArray<NewThreadRecommendedPrompt>;
  } | null>(null);
  const recommendations =
    generatedRecommendations?.activeProjectId === activeProjectId &&
    generatedRecommendations.activeProjectCwd === activeProjectCwd &&
    generatedRecommendations.contextTurnsSignature === contextTurnsSignature
      ? generatedRecommendations.recommendations
      : EMPTY_RECOMMENDED_PROMPTS;

  useEffect(() => {
    if (
      !activeProjectId ||
      !activeProjectCwd ||
      !modelSelectionSignature ||
      !fingerprint ||
      !requestKey
    ) {
      lastCompletedRequestKeyRef.current = null;
      return;
    }

    cleanupLegacyBrowserRecommendationCache();

    if (lastCompletedRequestKeyRef.current === requestKey) {
      return;
    }

    const now = Date.now();
    const cooldownUntil = recommendationFailureCooldownByFingerprint.get(fingerprint) ?? 0;
    if (cooldownUntil > now) {
      return;
    }

    let cancelled = false;
    void requestGeneratedRecommendations({
      cwd: activeProjectCwd,
      modelSelection: JSON.parse(modelSelectionSignature) as ModelSelection,
      turns: JSON.parse(contextTurnsSignature) as ReadonlyArray<RecommendationContextTurn>,
      fingerprint,
    })
      .then((generatedRecommendations) => {
        if (cancelled) {
          return;
        }
        const normalizedRecommendations = normalizeRecommendedPrompts(generatedRecommendations);
        lastCompletedRequestKeyRef.current = requestKey;
        setGeneratedRecommendations({
          activeProjectId,
          activeProjectCwd,
          contextTurnsSignature,
          requestKey,
          recommendations: normalizedRecommendations,
        });
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
  }, [
    activeProjectCwd,
    activeProjectId,
    contextTurnsSignature,
    fingerprint,
    requestKey,
    modelSelectionSignature,
  ]);

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
    <div className="new-thread-start-surface flex flex-1 flex-col items-center justify-start overflow-x-hidden overflow-y-auto px-4 sm:px-8">
      <section className="my-auto flex w-full min-w-0 max-w-3xl flex-col items-center text-center">
        <h1 className="new-thread-start-title max-w-full text-balance font-medium text-foreground/92">
          {title}
        </h1>

        {hasProjects ? (
          <div className="new-thread-start-body flex w-full min-w-0 flex-col items-center">
            <div className="new-thread-start-dock w-full min-w-0 max-w-3xl text-left">
              <div className="new-thread-start-composer w-full min-w-0 text-left">
                {composerNode}
              </div>

              <div className="new-thread-start-controls flex min-h-8 w-full min-w-0 flex-wrap items-center justify-start gap-x-3 gap-y-1 px-4 text-left">
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
