import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Archive,
  Bot,
  Check,
  ChevronLeft,
  CloudUpload,
  FileDiff,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitCommit,
  GitPullRequest,
  ListTodo,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react-native";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  PROVIDER_DISPLAY_NAMES,
  type GitResolvedPullRequest,
  type GitListBranchesResult,
  type GitHubIssue,
  type GitStackedAction,
  type GitStatusResult,
  type ProjectScript,
  type ProjectScriptIcon,
  type ProviderInteractionMode,
  type ProviderKind,
  type RuntimeMode,
  type ServerProvider,
} from "@ace/contracts";
import { newCommandId, newMessageId, newThreadId } from "@ace/shared/ids";
import {
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
} from "@ace/shared/git";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import { useTheme } from "../../src/design/ThemeContext";
import {
  EmptyState,
  IconButton,
  MetricCard,
  Panel,
  ScreenBackdrop,
  SectionTitle,
  StatusBadge,
} from "../../src/design/primitives";
import { formatTimeAgo, useAggregatedOrchestration } from "../../src/orchestration/mobileData";
import { formatErrorMessage } from "../../src/errors";
import {
  ImageAttachmentCapture,
  toUploadChatAttachments,
  type MobileImageAttachment,
} from "../../src/components/ImageAttachmentCapture";
import {
  buildIssueSelectionPrompt,
  buildIssueSelectionThreadTitle,
  makeThreadTitle,
  nextProjectScriptId,
  resolveModelSelection,
} from "../../src/project/projectThreadHelpers";
import { useMobilePreferencesStore } from "../../src/store/MobilePreferencesStore";

const DEFAULT_PROVIDER: ProviderKind = "codex";
const DEFAULT_SCRIPT_ICON: ProjectScriptIcon = "play";
const RUNTIME_OPTIONS: ReadonlyArray<{ value: RuntimeMode; label: string; description: string }> = [
  { value: "full-access", label: "Full", description: "Fastest path" },
  { value: "approval-required", label: "Review", description: "Ask first" },
];
const INTERACTION_OPTIONS: ReadonlyArray<{
  value: ProviderInteractionMode;
  label: string;
  description: string;
}> = [
  { value: "default", label: "Build", description: "Implement" },
  { value: "plan", label: "Plan", description: "Think first" },
];
const ISSUE_STATE_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
] as const;
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

type IssueStateFilter = (typeof ISSUE_STATE_OPTIONS)[number]["value"];

export default function ProjectDetailScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const diffWordWrap = useMobilePreferencesStore((state) => state.diffWordWrap);
  const { projectId, hostId } = useLocalSearchParams<{ projectId: string; hostId?: string }>();
  const { projects, threads, refresh, loading, connections } = useAggregatedOrchestration();
  const [showNewThread, setShowNewThread] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [composerImages, setComposerImages] = useState<MobileImageAttachment[]>([]);
  const [providers, setProviders] = useState<ReadonlyArray<ServerProvider>>([]);
  const [selectedProvider, setSelectedProvider] = useState<ProviderKind>(DEFAULT_PROVIDER);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>(
    DEFAULT_PROVIDER_INTERACTION_MODE,
  );
  const [creating, setCreating] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [scriptName, setScriptName] = useState("");
  const [scriptCommand, setScriptCommand] = useState("");
  const [scriptRunsOnSetup, setScriptRunsOnSetup] = useState(false);
  const [editingScriptId, setEditingScriptId] = useState<string | null>(null);
  const [savingScript, setSavingScript] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);
  const [gitBranches, setGitBranches] = useState<GitListBranchesResult | null>(null);
  const [loadingGit, setLoadingGit] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [gitAction, setGitAction] = useState<string | null>(null);
  const [gitProgress, setGitProgress] = useState<string | null>(null);
  const [lastPrUrl, setLastPrUrl] = useState<string | null>(null);
  const [workingTreeDiff, setWorkingTreeDiff] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [worktreeBranchName, setWorktreeBranchName] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [removingWorktreePath, setRemovingWorktreePath] = useState<string | null>(null);
  const [prReference, setPrReference] = useState("");
  const [resolvedPr, setResolvedPr] = useState<GitResolvedPullRequest | null>(null);
  const [preparingPrMode, setPreparingPrMode] = useState<"local" | "worktree" | null>(null);
  const [issueQuery, setIssueQuery] = useState("");
  const [issueStateFilter, setIssueStateFilter] = useState<IssueStateFilter>("open");
  const [issueLabelFilters, setIssueLabelFilters] = useState<ReadonlyArray<string>>([]);
  const [issues, setIssues] = useState<ReadonlyArray<GitHubIssue>>([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [selectedIssueNumbers, setSelectedIssueNumbers] = useState<ReadonlyArray<number>>([]);
  const [startingIssueNumbers, setStartingIssueNumbers] = useState<ReadonlyArray<number>>([]);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [projectTitleDraft, setProjectTitleDraft] = useState("");
  const [projectPathDraft, setProjectPathDraft] = useState("");
  const [savingProjectMeta, setSavingProjectMeta] = useState(false);
  const [projectMetaError, setProjectMetaError] = useState<string | null>(null);

  const entry = useMemo(
    () =>
      projects.find((project) => {
        if (project.project.id !== projectId) {
          return false;
        }
        if (!hostId) {
          return true;
        }
        return project.hostId === hostId;
      }) ?? null,
    [hostId, projectId, projects],
  );

  const projectThreads = useMemo(
    () =>
      threads.filter(
        (thread) => thread.thread.projectId === projectId && (!hostId || thread.hostId === hostId),
      ),
    [hostId, projectId, threads],
  );

  const connection = useMemo(() => {
    if (!entry) {
      return null;
    }
    return connections.find((candidate) => candidate.host.id === entry.hostId) ?? null;
  }, [connections, entry]);

  const currentBranchIsDefault = useMemo(() => {
    const branchName = gitStatus?.branch;
    if (!branchName) {
      return false;
    }
    const branch = gitBranches?.branches.find((candidate) => candidate.name === branchName);
    return branch?.isDefault ?? (branchName === "main" || branchName === "master");
  }, [gitBranches?.branches, gitStatus?.branch]);

  useEffect(() => {
    if (!entry) {
      setProjectTitleDraft("");
      setProjectPathDraft("");
      return;
    }
    setProjectTitleDraft(entry.project.title);
    setProjectPathDraft(entry.project.workspaceRoot);
  }, [entry]);

  const selectableProviders = useMemo(() => {
    const readyProviders = providers.filter(
      (provider) =>
        provider.enabled &&
        provider.installed &&
        provider.status !== "disabled" &&
        provider.auth.status !== "unauthenticated",
    );
    return readyProviders.length > 0
      ? readyProviders
      : [
          {
            provider: DEFAULT_PROVIDER,
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "unknown" },
            checkedAt: new Date().toISOString(),
            models: [],
          } satisfies ServerProvider,
        ];
  }, [providers]);

  const selectableModels = useMemo(() => {
    const providerConfig = selectableProviders.find(
      (provider) => provider.provider === selectedProvider,
    );
    return providerConfig?.models ?? [];
  }, [selectableProviders, selectedProvider]);

  useEffect(() => {
    if (!connection || connection.status.kind !== "connected") {
      setProviders([]);
      setSelectedProvider(DEFAULT_PROVIDER);
      return;
    }

    let cancelled = false;
    connection.client.server
      .getConfig()
      .then((config) => {
        if (cancelled) {
          return;
        }
        setProviders(config.providers);
        const preferred =
          entry?.project.defaultModelSelection?.provider ??
          config.providers.find((provider) => provider.enabled && provider.installed)?.provider ??
          DEFAULT_PROVIDER;
        setSelectedProvider(preferred);
        setSelectedModel(
          entry?.project.defaultModelSelection?.provider === preferred
            ? entry.project.defaultModelSelection.model
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setProviders([]);
          setSelectedProvider(DEFAULT_PROVIDER);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    connection,
    entry?.project.defaultModelSelection?.model,
    entry?.project.defaultModelSelection?.provider,
  ]);

  useEffect(() => {
    const modelStillAvailable = selectableModels.some((model) => model.slug === selectedModel);
    if (selectedModel && modelStillAvailable) {
      return;
    }

    const defaultModel = DEFAULT_MODEL_BY_PROVIDER[selectedProvider];
    setSelectedModel(
      selectableModels.find((model) => model.slug === defaultModel)?.slug ??
        selectableModels[0]?.slug ??
        defaultModel,
    );
  }, [selectableModels, selectedModel, selectedProvider]);

  const createThread = useCallback(async () => {
    if (!entry || !connection || connection.status.kind !== "connected") {
      setComposerError("Connect this host before starting a new agent thread.");
      return;
    }

    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const trimmedPrompt = prompt.trim();
    const attachments = toUploadChatAttachments(composerImages);
    const modelSelection = resolveModelSelection(
      selectedProvider,
      selectableProviders,
      selectedModel,
    );

    setCreating(true);
    setComposerError(null);
    try {
      await connection.client.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId,
        projectId: entry.project.id,
        title: makeThreadTitle(trimmedPrompt, composerImages[0]?.name),
        modelSelection,
        runtimeMode,
        interactionMode,
        branch: null,
        worktreePath: entry.project.workspaceRoot,
        createdAt,
      });

      if (trimmedPrompt.length > 0 || attachments.length > 0) {
        await connection.client.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: trimmedPrompt.length > 0 ? trimmedPrompt : IMAGE_ONLY_BOOTSTRAP_PROMPT,
            attachments,
          },
          modelSelection,
          runtimeMode,
          interactionMode,
          createdAt: new Date().toISOString(),
        });
      }

      setPrompt("");
      setComposerImages([]);
      setShowNewThread(false);
      await refresh();
      router.push({
        pathname: "/thread/[threadId]",
        params: { threadId, hostId: entry.hostId },
      });
    } catch (cause) {
      setComposerError(formatErrorMessage(cause));
    } finally {
      setCreating(false);
    }
  }, [
    connection,
    composerImages,
    entry,
    interactionMode,
    prompt,
    refresh,
    router,
    runtimeMode,
    selectableProviders,
    selectedModel,
    selectedProvider,
  ]);

  const refreshGit = useCallback(async () => {
    if (!entry || !connection || connection.status.kind !== "connected") {
      setGitStatus(null);
      setGitBranches(null);
      setGitError(null);
      setWorkingTreeDiff(null);
      return;
    }

    setLoadingGit(true);
    setGitError(null);
    try {
      const [status, branches] = await Promise.all([
        connection.client.git.status({ cwd: entry.project.workspaceRoot }),
        connection.client.git.listBranches({ cwd: entry.project.workspaceRoot }),
      ]);
      setGitStatus(status);
      setGitBranches(branches);
      if (!status.hasWorkingTreeChanges) {
        setWorkingTreeDiff(null);
      }
    } catch (cause) {
      setGitStatus(null);
      setGitBranches(null);
      setWorkingTreeDiff(null);
      setGitError(formatErrorMessage(cause));
    } finally {
      setLoadingGit(false);
    }
  }, [connection, entry]);

  useEffect(() => {
    void refreshGit();
  }, [refreshGit]);

  const initGit = useCallback(async () => {
    if (!entry || !connection || connection.status.kind !== "connected" || gitAction) {
      return;
    }

    setGitAction("init");
    setGitProgress("Initializing repository...");
    setGitError(null);
    try {
      await connection.client.git.init({ cwd: entry.project.workspaceRoot });
      setGitProgress("Repository initialized.");
      await refreshGit();
    } catch (cause) {
      setGitError(formatErrorMessage(cause));
    } finally {
      setGitAction(null);
    }
  }, [connection, entry, gitAction, refreshGit]);

  const loadWorkingTreeDiff = useCallback(async () => {
    if (!entry || !connection || connection.status.kind !== "connected") {
      setGitError("Connect this host before loading the working tree diff.");
      return;
    }

    setLoadingDiff(true);
    setGitError(null);
    try {
      const result = await connection.client.git.readWorkingTreeDiff({
        cwd: entry.project.workspaceRoot,
      });
      setWorkingTreeDiff(result.diff);
    } catch (cause) {
      setWorkingTreeDiff(null);
      setGitError(formatErrorMessage(cause));
    } finally {
      setLoadingDiff(false);
    }
  }, [connection, entry]);

  const createPreparedThread = useCallback(
    async (input: { title: string; branch: string | null; worktreePath: string }) => {
      if (!entry || !connection || connection.status.kind !== "connected") {
        setGitError("Connect this host before creating a prepared thread.");
        return;
      }

      const threadId = newThreadId();
      await connection.client.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId,
        projectId: entry.project.id,
        title: input.title,
        modelSelection: resolveModelSelection(selectedProvider, selectableProviders, selectedModel),
        runtimeMode,
        interactionMode,
        branch: input.branch,
        worktreePath: input.worktreePath,
        createdAt: new Date().toISOString(),
      });
      await refresh();
      router.push({
        pathname: "/thread/[threadId]",
        params: { threadId, hostId: entry.hostId },
      });
    },
    [
      connection,
      entry,
      interactionMode,
      refresh,
      router,
      runtimeMode,
      selectableProviders,
      selectedModel,
      selectedProvider,
    ],
  );

  const createWorktreeThread = useCallback(async () => {
    if (!entry || !connection || connection.status.kind !== "connected" || gitAction) {
      return;
    }

    const baseBranch = gitStatus?.branch?.trim();
    const newBranch = worktreeBranchName.trim();
    const path = worktreePath.trim();
    if (!baseBranch) {
      setGitError("Check out a base branch before creating a worktree.");
      return;
    }

    setGitAction("worktree");
    setGitProgress("Creating worktree...");
    setGitError(null);
    try {
      const result = await connection.client.git.createWorktree({
        cwd: entry.project.workspaceRoot,
        branch: baseBranch,
        ...(newBranch.length > 0 ? { newBranch } : {}),
        path: path.length > 0 ? path : null,
      });
      setWorktreeBranchName("");
      setWorktreePath("");
      setGitProgress(`Created worktree ${result.worktree.branch}`);
      await createPreparedThread({
        title: `Worktree: ${result.worktree.branch}`,
        branch: result.worktree.branch,
        worktreePath: result.worktree.path,
      });
      await refreshGit();
    } catch (cause) {
      setGitError(formatErrorMessage(cause));
    } finally {
      setGitAction(null);
    }
  }, [
    connection,
    createPreparedThread,
    entry,
    gitAction,
    gitStatus?.branch,
    refreshGit,
    worktreeBranchName,
    worktreePath,
  ]);

  const removeWorktree = useCallback(
    (path: string) => {
      if (!entry || !connection || connection.status.kind !== "connected") {
        setGitError("Connect this host before removing a worktree.");
        return;
      }

      Alert.alert("Remove worktree", `Remove ${path}?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            setRemovingWorktreePath(path);
            setGitError(null);
            connection.client.git
              .removeWorktree({
                cwd: entry.project.workspaceRoot,
                path,
                force: true,
              })
              .then(async () => {
                setGitProgress("Worktree removed.");
                await refreshGit();
              })
              .catch((cause: unknown) => {
                setGitError(formatErrorMessage(cause));
              })
              .finally(() => {
                setRemovingWorktreePath(null);
              });
          },
        },
      ]);
    },
    [connection, entry, refreshGit],
  );

  const resolvePullRequest = useCallback(async () => {
    if (!entry || !connection || connection.status.kind !== "connected") {
      setGitError("Connect this host before resolving a pull request.");
      return;
    }

    const reference = prReference.trim();
    if (reference.length === 0) {
      setGitError("Enter a pull request URL, number, or #number first.");
      return;
    }

    setPreparingPrMode("local");
    setGitError(null);
    try {
      const result = await connection.client.git.resolvePullRequest({
        cwd: entry.project.workspaceRoot,
        reference,
      });
      setResolvedPr(result.pullRequest);
      setGitProgress(`Resolved PR #${result.pullRequest.number}`);
    } catch (cause) {
      setResolvedPr(null);
      setGitError(formatErrorMessage(cause));
    } finally {
      setPreparingPrMode(null);
    }
  }, [connection, entry, prReference]);

  const preparePullRequestThread = useCallback(
    async (mode: "local" | "worktree") => {
      if (!entry || !connection || connection.status.kind !== "connected" || preparingPrMode) {
        return;
      }

      const reference = prReference.trim();
      if (reference.length === 0) {
        setGitError("Enter a pull request URL, number, or #number first.");
        return;
      }

      setPreparingPrMode(mode);
      setGitError(null);
      try {
        const result = await connection.client.git.preparePullRequestThread({
          cwd: entry.project.workspaceRoot,
          reference,
          mode,
        });
        setResolvedPr(result.pullRequest);
        setGitProgress(
          result.worktreePath
            ? `Prepared PR #${result.pullRequest.number} in a worktree.`
            : `Checked out PR #${result.pullRequest.number}.`,
        );
        await createPreparedThread({
          title: `PR #${result.pullRequest.number}: ${result.pullRequest.title}`,
          branch: result.branch,
          worktreePath: result.worktreePath ?? entry.project.workspaceRoot,
        });
        await refreshGit();
      } catch (cause) {
        setGitError(formatErrorMessage(cause));
      } finally {
        setPreparingPrMode(null);
      }
    },
    [connection, createPreparedThread, entry, prReference, preparingPrMode, refreshGit],
  );

  const runGitAction = useCallback(
    async (action: GitStackedAction, options?: { confirmedDefaultBranch?: boolean }) => {
      if (!entry || !connection || connection.status.kind !== "connected" || gitAction) {
        return;
      }

      if (
        !options?.confirmedDefaultBranch &&
        gitStatus?.branch &&
        requiresDefaultBranchConfirmation(action, currentBranchIsDefault)
      ) {
        const copy = resolveDefaultBranchActionDialogCopy({
          action: action as DefaultBranchConfirmableAction,
          branchName: gitStatus.branch,
          includesCommit: action === "commit_push" || action === "commit_push_pr",
        });
        Alert.alert(copy.title, copy.description, [
          { text: "Abort", style: "cancel" },
          {
            text: copy.continueLabel,
            style: "destructive",
            onPress: () => {
              void runGitAction(action, { confirmedDefaultBranch: true });
            },
          },
        ]);
        return;
      }

      setGitAction(action);
      setGitProgress("Starting git action...");
      setGitError(null);
      try {
        const trimmedMessage = commitMessage.trim();
        const result = await connection.client.git.runStackedAction(
          {
            actionId: newCommandId(),
            cwd: entry.project.workspaceRoot,
            action,
            ...(trimmedMessage.length > 0 ? { commitMessage: trimmedMessage } : {}),
          },
          {
            onProgress: (event) => {
              if (event.kind === "phase_started") {
                setGitProgress(event.label);
                return;
              }
              if (event.kind === "hook_output") {
                setGitProgress(event.text);
                return;
              }
              if (event.kind === "action_failed") {
                setGitProgress(event.message);
              }
            },
          },
        );
        setGitProgress(result.toast.title);
        setLastPrUrl(
          result.pr.url ?? (result.toast.cta.kind === "open_pr" ? result.toast.cta.url : null),
        );
        setCommitMessage("");
        await refreshGit();
      } catch (cause) {
        setGitError(formatErrorMessage(cause));
      } finally {
        setGitAction(null);
      }
    },
    [
      commitMessage,
      connection,
      currentBranchIsDefault,
      entry,
      gitAction,
      gitStatus?.branch,
      refreshGit,
    ],
  );

  const openPullRequest = useCallback(async () => {
    const url = gitStatus?.pr?.url ?? lastPrUrl;
    if (!url) {
      return;
    }
    await Linking.openURL(url);
  }, [gitStatus?.pr?.url, lastPrUrl]);

  const pullGit = useCallback(async () => {
    if (!entry || !connection || connection.status.kind !== "connected" || gitAction) {
      return;
    }

    setGitAction("pull");
    setGitProgress("Pulling latest changes...");
    setGitError(null);
    try {
      const result = await connection.client.git.pull({ cwd: entry.project.workspaceRoot });
      setGitProgress(
        result.status === "pulled"
          ? `Pulled ${result.branch}`
          : `${result.branch} is already up to date`,
      );
      await refreshGit();
    } catch (cause) {
      setGitError(formatErrorMessage(cause));
    } finally {
      setGitAction(null);
    }
  }, [connection, entry, gitAction, refreshGit]);

  const checkoutBranch = useCallback(
    async (branch: string) => {
      if (!entry || !connection || connection.status.kind !== "connected" || gitAction) {
        return;
      }

      setGitAction(`checkout:${branch}`);
      setGitError(null);
      try {
        await connection.client.git.checkout({
          cwd: entry.project.workspaceRoot,
          branch,
        });
        setGitProgress(`Checked out ${branch}`);
        await refreshGit();
      } catch (cause) {
        setGitError(formatErrorMessage(cause));
      } finally {
        setGitAction(null);
      }
    },
    [connection, entry, gitAction, refreshGit],
  );

  const createBranch = useCallback(async () => {
    if (!entry || !connection || connection.status.kind !== "connected" || gitAction) {
      return;
    }

    const branch = newBranchName.trim();
    if (branch.length === 0) {
      setGitError("Enter a branch name first.");
      return;
    }

    setGitAction(`create:${branch}`);
    setGitError(null);
    try {
      await connection.client.git.createBranch({
        cwd: entry.project.workspaceRoot,
        branch,
      });
      await connection.client.git.checkout({
        cwd: entry.project.workspaceRoot,
        branch,
      });
      setNewBranchName("");
      setGitProgress(`Created and checked out ${branch}`);
      await refreshGit();
    } catch (cause) {
      setGitError(formatErrorMessage(cause));
    } finally {
      setGitAction(null);
    }
  }, [connection, entry, gitAction, newBranchName, refreshGit]);

  const loadIssues = useCallback(async () => {
    if (!entry || !connection || connection.status.kind !== "connected") {
      setIssues([]);
      setIssueError("Connect this host before loading GitHub issues.");
      return;
    }

    setLoadingIssues(true);
    setIssueError(null);
    try {
      const query = issueQuery.trim();
      const result = await connection.client.git.listGitHubIssues({
        cwd: entry.project.workspaceRoot,
        limit: 25,
        state: issueStateFilter,
        ...(issueLabelFilters.length > 0 ? { labels: [...issueLabelFilters] } : {}),
        ...(query.length > 0 ? { query } : {}),
      });
      setIssues(result.issues);
      setSelectedIssueNumbers((current) => {
        const visible = new Set(result.issues.map((issue) => issue.number));
        return current.filter((issueNumber) => visible.has(issueNumber));
      });
    } catch (cause) {
      setIssues([]);
      setSelectedIssueNumbers([]);
      setIssueError(formatErrorMessage(cause));
    } finally {
      setLoadingIssues(false);
    }
  }, [connection, entry, issueLabelFilters, issueQuery, issueStateFilter]);

  useEffect(() => {
    void loadIssues();
  }, [loadIssues]);

  const visibleIssueNumbers = useMemo(
    () => issues.slice(0, 8).map((issue) => issue.number),
    [issues],
  );

  const availableIssueLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) {
      for (const label of issue.labels) {
        counts.set(label.name, (counts.get(label.name) ?? 0) + 1);
      }
    }

    const sorted = Array.from(counts.entries())
      .toSorted((left, right) => {
        if (right[1] !== left[1]) {
          return right[1] - left[1];
        }
        return left[0].localeCompare(right[0]);
      })
      .slice(0, 12)
      .map(([label, count]) => ({ label, count }));

    for (const selected of issueLabelFilters) {
      if (!sorted.some((entry) => entry.label === selected)) {
        sorted.unshift({ label: selected, count: 0 });
      }
    }

    return sorted;
  }, [issueLabelFilters, issues]);

  const selectedVisibleIssueNumbers = useMemo(() => {
    const visible = new Set(visibleIssueNumbers);
    return selectedIssueNumbers.filter((issueNumber) => visible.has(issueNumber));
  }, [selectedIssueNumbers, visibleIssueNumbers]);

  const toggleIssueSelection = useCallback((issueNumber: number) => {
    setSelectedIssueNumbers((current) =>
      current.includes(issueNumber)
        ? current.filter((candidate) => candidate !== issueNumber)
        : [...current, issueNumber],
    );
  }, []);

  const toggleIssueLabelFilter = useCallback((label: string) => {
    setIssueLabelFilters((current) =>
      current.includes(label)
        ? current.filter((candidate) => candidate !== label)
        : [...current, label],
    );
  }, []);

  const selectAllVisibleIssues = useCallback(() => {
    setSelectedIssueNumbers((current) => {
      const currentSet = new Set(current);
      const allVisibleSelected =
        visibleIssueNumbers.length > 0 &&
        visibleIssueNumbers.every((issueNumber) => currentSet.has(issueNumber));
      if (allVisibleSelected) {
        const visible = new Set(visibleIssueNumbers);
        return current.filter((issueNumber) => !visible.has(issueNumber));
      }
      for (const issueNumber of visibleIssueNumbers) {
        currentSet.add(issueNumber);
      }
      return [...currentSet];
    });
  }, [visibleIssueNumbers]);

  const startIssueThread = useCallback(
    async (issueNumbers: ReadonlyArray<number>) => {
      const normalizedIssueNumbers = Array.from(new Set(issueNumbers)).filter(
        (issueNumber) => Number.isInteger(issueNumber) && issueNumber > 0,
      );
      if (
        !entry ||
        !connection ||
        connection.status.kind !== "connected" ||
        startingIssueNumbers.length > 0 ||
        normalizedIssueNumbers.length === 0
      ) {
        return;
      }

      setStartingIssueNumbers(normalizedIssueNumbers);
      setIssueError(null);
      try {
        const issueThreads = await Promise.all(
          normalizedIssueNumbers.map(async (issueNumber) => {
            const result = await connection.client.git.getGitHubIssueThread({
              cwd: entry.project.workspaceRoot,
              issueNumber,
            });
            return result.issue;
          }),
        );
        const threadId = newThreadId();
        const createdAt = new Date().toISOString();
        const promptText = buildIssueSelectionPrompt(issueThreads);
        const modelSelection = resolveModelSelection(
          selectedProvider,
          selectableProviders,
          selectedModel,
        );

        await connection.client.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId: entry.project.id,
          title: buildIssueSelectionThreadTitle(issueThreads),
          modelSelection,
          runtimeMode,
          interactionMode,
          branch: null,
          worktreePath: entry.project.workspaceRoot,
          createdAt,
        });
        await connection.client.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: promptText,
            attachments: [],
          },
          modelSelection,
          runtimeMode,
          interactionMode,
          createdAt: new Date().toISOString(),
        });
        setSelectedIssueNumbers([]);
        await refresh();
        router.push({
          pathname: "/thread/[threadId]",
          params: { threadId, hostId: entry.hostId },
        });
      } catch (cause) {
        setIssueError(formatErrorMessage(cause));
      } finally {
        setStartingIssueNumbers([]);
      }
    },
    [
      connection,
      entry,
      interactionMode,
      refresh,
      router,
      runtimeMode,
      selectableProviders,
      selectedModel,
      selectedProvider,
      startingIssueNumbers.length,
    ],
  );

  const persistScripts = useCallback(
    async (nextScripts: ReadonlyArray<ProjectScript>): Promise<boolean> => {
      if (!entry || !connection || connection.status.kind !== "connected") {
        setScriptError("Connect this host before editing project scripts.");
        return false;
      }

      setSavingScript(true);
      setScriptError(null);
      try {
        await connection.client.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId: entry.project.id,
          scripts: [...nextScripts],
        });
        await refresh();
        return true;
      } catch (cause) {
        setScriptError(formatErrorMessage(cause));
        return false;
      } finally {
        setSavingScript(false);
      }
    },
    [connection, entry, refresh],
  );

  const resetScriptForm = useCallback(() => {
    setScriptName("");
    setScriptCommand("");
    setScriptRunsOnSetup(false);
    setEditingScriptId(null);
  }, []);

  const saveScript = useCallback(async () => {
    if (!entry) {
      return;
    }

    const name = scriptName.trim();
    const command = scriptCommand.trim();
    if (name.length === 0 || command.length === 0) {
      setScriptError("Script name and command are required.");
      return;
    }

    const nextScript: ProjectScript = {
      id: editingScriptId ?? nextProjectScriptId(name, entry.project.scripts),
      name,
      command,
      icon: DEFAULT_SCRIPT_ICON,
      runOnWorktreeCreate: scriptRunsOnSetup,
    };
    const nextScripts = editingScriptId
      ? entry.project.scripts.map((script) => (script.id === editingScriptId ? nextScript : script))
      : [...entry.project.scripts, nextScript];

    if (await persistScripts(nextScripts)) {
      resetScriptForm();
    }
  }, [
    editingScriptId,
    entry,
    persistScripts,
    resetScriptForm,
    scriptCommand,
    scriptName,
    scriptRunsOnSetup,
  ]);

  const editScript = useCallback((script: ProjectScript) => {
    setEditingScriptId(script.id);
    setScriptName(script.name);
    setScriptCommand(script.command);
    setScriptRunsOnSetup(script.runOnWorktreeCreate);
  }, []);

  const deleteScript = useCallback(
    (scriptId: string) => {
      if (!entry) {
        return;
      }

      const script = entry.project.scripts.find((candidate) => candidate.id === scriptId);
      Alert.alert("Delete script", script ? `Delete ${script.name}?` : "Delete this script?", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void persistScripts(
              entry.project.scripts.filter((candidate) => candidate.id !== scriptId),
            ).then((saved) => {
              if (saved && editingScriptId === scriptId) {
                resetScriptForm();
              }
            });
          },
        },
      ]);
    },
    [editingScriptId, entry, persistScripts, resetScriptForm],
  );

  const runScript = useCallback(
    (script: ProjectScript) => {
      if (!entry) {
        return;
      }
      router.push({
        pathname: "/thread/terminal",
        params: {
          threadId: `project-${entry.project.id}`,
          hostId: entry.hostId,
          cwd: entry.project.workspaceRoot,
          initialCommand: script.command,
        },
      });
    },
    [entry, router],
  );

  const saveProjectMeta = useCallback(async () => {
    if (!entry || !connection || connection.status.kind !== "connected") {
      setProjectMetaError("Connect this host before editing project settings.");
      return;
    }

    const title = projectTitleDraft.trim();
    const workspaceRoot = projectPathDraft.trim();
    if (title.length === 0 || workspaceRoot.length === 0) {
      setProjectMetaError("Project name and workspace path are required.");
      return;
    }

    setSavingProjectMeta(true);
    setProjectMetaError(null);
    try {
      await connection.client.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: entry.project.id,
        title,
        workspaceRoot,
      });
      await refresh();
      setShowProjectSettings(false);
    } catch (cause) {
      setProjectMetaError(formatErrorMessage(cause));
    } finally {
      setSavingProjectMeta(false);
    }
  }, [connection, entry, projectPathDraft, projectTitleDraft, refresh]);

  const setProjectArchived = useCallback(
    async (archived: boolean) => {
      if (!entry || !connection || connection.status.kind !== "connected") {
        setProjectMetaError("Connect this host before changing archive state.");
        return;
      }

      setSavingProjectMeta(true);
      setProjectMetaError(null);
      try {
        await connection.client.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId: entry.project.id,
          archivedAt: archived ? new Date().toISOString() : null,
        });
        await refresh();
        if (archived) {
          router.back();
        }
      } catch (cause) {
        setProjectMetaError(formatErrorMessage(cause));
      } finally {
        setSavingProjectMeta(false);
      }
    },
    [connection, entry, refresh, router],
  );

  const deleteProject = useCallback(() => {
    if (!entry || !connection || connection.status.kind !== "connected") {
      setProjectMetaError("Connect this host before deleting the project.");
      return;
    }

    Alert.alert(
      "Delete project",
      `Delete ${entry.project.title}? Threads and project metadata will be removed from this host.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            setSavingProjectMeta(true);
            setProjectMetaError(null);
            connection.client.orchestration
              .dispatchCommand({
                type: "project.delete",
                commandId: newCommandId(),
                projectId: entry.project.id,
              })
              .then(async () => {
                await refresh();
                router.back();
              })
              .catch((cause: unknown) => {
                setProjectMetaError(formatErrorMessage(cause));
              })
              .finally(() => {
                setSavingProjectMeta(false);
              });
          },
        },
      ],
    );
  }, [connection, entry, refresh, router]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScreenBackdrop />
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 48,
        }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} />}
      >
        <View style={styles.headerRow}>
          <Pressable
            onPress={() => router.back()}
            style={[
              styles.backButton,
              {
                backgroundColor: colors.surface,
                borderColor: colors.elevatedBorder,
                shadowColor: colors.shadow,
              },
            ]}
          >
            <ChevronLeft size={18} color={colors.foreground} strokeWidth={2.2} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={[styles.eyebrow, { color: colors.tertiaryLabel }]}>Project</Text>
            <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
              {entry?.project.title ?? "Project"}
            </Text>
            <Text style={[styles.subtitle, { color: colors.secondaryLabel }]} numberOfLines={1}>
              {entry?.hostName ?? "Unknown host"} · {projectThreads.length} threads
            </Text>
          </View>
          {entry ? (
            <IconButton
              icon={Plus}
              label="Agent"
              onPress={() => setShowNewThread((current) => !current)}
            />
          ) : null}
        </View>

        {entry ? (
          <>
            <Panel style={styles.heroPanel}>
              <View style={styles.heroRow}>
                <View
                  style={[
                    styles.heroIcon,
                    {
                      backgroundColor: withAlpha(colors.primary, 0.14),
                    },
                  ]}
                >
                  <FolderGit2 size={20} color={colors.primary} strokeWidth={2.1} />
                </View>
                <View style={styles.heroCopy}>
                  <Text style={[styles.heroLabel, { color: colors.tertiaryLabel }]}>
                    Workspace root
                  </Text>
                  <Text style={[styles.heroPath, { color: colors.foreground }]} numberOfLines={2}>
                    {entry.project.workspaceRoot}
                  </Text>
                </View>
              </View>
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: "/project/files",
                    params: {
                      projectId: entry.project.id,
                      hostId: entry.hostId,
                      cwd: entry.project.workspaceRoot,
                      title: entry.project.title,
                      hostName: entry.hostName,
                    },
                  })
                }
                style={[
                  styles.filesButton,
                  {
                    backgroundColor: colors.surfaceSecondary,
                    borderColor: colors.elevatedBorder,
                  },
                ]}
              >
                <FileCode2 size={17} color={colors.primary} strokeWidth={2.2} />
                <Text style={[styles.filesButtonText, { color: colors.foreground }]}>
                  Browse files
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setShowProjectSettings((current) => !current)}
                style={[
                  styles.filesButton,
                  {
                    backgroundColor: colors.surfaceSecondary,
                    borderColor: colors.elevatedBorder,
                  },
                ]}
              >
                <Pencil size={17} color={colors.primary} strokeWidth={2.2} />
                <Text style={[styles.filesButtonText, { color: colors.foreground }]}>
                  Project settings
                </Text>
              </Pressable>
            </Panel>

            <View style={styles.metricRow}>
              <MetricCard label="Live" value={entry.liveCount} tone="success" />
              <MetricCard label="Pending" value={entry.pendingCount} tone="warning" />
              <MetricCard label="Completed" value={entry.completedCount} tone="muted" />
            </View>

            {showProjectSettings ? (
              <Panel style={styles.projectSettingsPanel}>
                <View style={styles.settingsHeader}>
                  <View>
                    <SectionTitle>Project Settings</SectionTitle>
                    <Text style={[styles.settingsMeta, { color: colors.secondaryLabel }]}>
                      Update metadata on {entry.hostName}
                    </Text>
                  </View>
                  {entry.project.archivedAt ? (
                    <StatusBadge label="archived" tone="warning" />
                  ) : (
                    <StatusBadge label="active" tone="success" />
                  )}
                </View>
                <TextInput
                  value={projectTitleDraft}
                  onChangeText={setProjectTitleDraft}
                  placeholder="Project name"
                  placeholderTextColor={colors.muted}
                  style={[
                    styles.settingsInput,
                    {
                      color: colors.foreground,
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                />
                <TextInput
                  value={projectPathDraft}
                  onChangeText={setProjectPathDraft}
                  placeholder="/absolute/path/to/project"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[
                    styles.settingsInput,
                    {
                      color: colors.foreground,
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                />
                {projectMetaError ? (
                  <Text style={[styles.errorText, { color: colors.red }]}>{projectMetaError}</Text>
                ) : null}
                <View style={styles.settingsActions}>
                  <Pressable
                    disabled={savingProjectMeta}
                    onPress={() => void saveProjectMeta()}
                    style={[
                      styles.settingsPrimaryButton,
                      { backgroundColor: colors.primary },
                      savingProjectMeta && styles.disabled,
                    ]}
                  >
                    {savingProjectMeta ? (
                      <ActivityIndicator color={colors.primaryForeground} />
                    ) : (
                      <Text
                        style={[styles.settingsButtonText, { color: colors.primaryForeground }]}
                      >
                        Save
                      </Text>
                    )}
                  </Pressable>
                  <Pressable
                    disabled={savingProjectMeta}
                    onPress={() => void setProjectArchived(!entry.project.archivedAt)}
                    style={[
                      styles.settingsSecondaryButton,
                      {
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.elevatedBorder,
                      },
                      savingProjectMeta && styles.disabled,
                    ]}
                  >
                    <Archive size={15} color={colors.foreground} strokeWidth={2.1} />
                    <Text style={[styles.settingsButtonText, { color: colors.foreground }]}>
                      {entry.project.archivedAt ? "Unarchive" : "Archive"}
                    </Text>
                  </Pressable>
                </View>
                <Pressable
                  disabled={savingProjectMeta}
                  onPress={deleteProject}
                  style={[
                    styles.deleteProjectButton,
                    {
                      backgroundColor: withAlpha(colors.red, 0.12),
                      borderColor: withAlpha(colors.red, 0.2),
                    },
                    savingProjectMeta && styles.disabled,
                  ]}
                >
                  <Trash2 size={15} color={colors.red} strokeWidth={2.1} />
                  <Text style={[styles.settingsButtonText, { color: colors.red }]}>
                    Delete project
                  </Text>
                </Pressable>
              </Panel>
            ) : null}

            <Panel style={styles.gitPanel}>
              <View style={styles.gitHeader}>
                <View style={styles.gitTitleRow}>
                  <GitBranch size={18} color={colors.primary} strokeWidth={2.1} />
                  <View>
                    <SectionTitle>Git</SectionTitle>
                    <Text style={[styles.gitMeta, { color: colors.secondaryLabel }]}>
                      {gitStatus?.branch ?? "No branch"} · +{gitStatus?.workingTree.insertions ?? 0}{" "}
                      / -{gitStatus?.workingTree.deletions ?? 0}
                    </Text>
                  </View>
                </View>
                <Pressable
                  disabled={loadingGit}
                  onPress={() => void refreshGit()}
                  style={styles.gitRefreshButton}
                >
                  {loadingGit ? (
                    <ActivityIndicator color={colors.primary} />
                  ) : (
                    <RefreshCw size={16} color={colors.primary} strokeWidth={2.2} />
                  )}
                </Pressable>
              </View>

              {gitError ? (
                <Text style={[styles.errorText, { color: colors.red }]}>{gitError}</Text>
              ) : null}

              {!gitStatus && connection?.status.kind === "connected" ? (
                <Pressable
                  disabled={gitAction !== null}
                  onPress={() => void initGit()}
                  style={[
                    styles.initGitButton,
                    {
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                    gitAction !== null && styles.disabled,
                  ]}
                >
                  <FolderGit2 size={15} color={colors.foreground} strokeWidth={2.1} />
                  <Text style={[styles.gitActionText, { color: colors.foreground }]}>
                    Initialize Git repository
                  </Text>
                </Pressable>
              ) : null}

              {gitBranches?.branches.length ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.branchStrip}
                >
                  {gitBranches.branches
                    .filter((branch) => !branch.isRemote)
                    .map((branch) => {
                      const active = branch.current;
                      return (
                        <Pressable
                          key={branch.name}
                          disabled={active || gitAction !== null}
                          onPress={() => void checkoutBranch(branch.name)}
                          style={[
                            styles.branchChip,
                            {
                              backgroundColor: active
                                ? withAlpha(colors.primary, 0.12)
                                : colors.surfaceSecondary,
                              borderColor: active
                                ? withAlpha(colors.primary, 0.38)
                                : colors.elevatedBorder,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.branchChipText,
                              { color: active ? colors.primary : colors.secondaryLabel },
                            ]}
                          >
                            {branch.name}
                          </Text>
                        </Pressable>
                      );
                    })}
                </ScrollView>
              ) : null}

              <View style={styles.branchCreateRow}>
                <TextInput
                  value={newBranchName}
                  onChangeText={setNewBranchName}
                  placeholder="new-feature-branch"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[
                    styles.branchCreateInput,
                    {
                      color: colors.foreground,
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                />
                <Pressable
                  disabled={gitAction !== null || newBranchName.trim().length === 0}
                  onPress={() => void createBranch()}
                  style={[
                    styles.branchCreateButton,
                    {
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                    (gitAction !== null || newBranchName.trim().length === 0) && styles.disabled,
                  ]}
                >
                  <Text style={[styles.branchCreateText, { color: colors.foreground }]}>
                    Create
                  </Text>
                </Pressable>
              </View>

              <View style={styles.worktreePanel}>
                <View style={styles.worktreeHeader}>
                  <View style={styles.gitTitleRow}>
                    <FolderGit2 size={16} color={colors.primary} strokeWidth={2.1} />
                    <View>
                      <Text style={[styles.worktreeTitle, { color: colors.foreground }]}>
                        Worktrees
                      </Text>
                      <Text style={[styles.worktreeMeta, { color: colors.secondaryLabel }]}>
                        Create isolated mobile agent threads
                      </Text>
                    </View>
                  </View>
                </View>
                <TextInput
                  value={worktreeBranchName}
                  onChangeText={setWorktreeBranchName}
                  placeholder="new branch name (optional)"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[
                    styles.worktreeInput,
                    {
                      color: colors.foreground,
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                />
                <TextInput
                  value={worktreePath}
                  onChangeText={setWorktreePath}
                  placeholder="worktree path (optional)"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[
                    styles.worktreeInput,
                    {
                      color: colors.foreground,
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                />
                <Pressable
                  disabled={gitAction !== null || !gitStatus?.branch}
                  onPress={() => void createWorktreeThread()}
                  style={[
                    styles.worktreePrimaryButton,
                    { backgroundColor: colors.primary },
                    (gitAction !== null || !gitStatus?.branch) && styles.disabled,
                  ]}
                >
                  {gitAction === "worktree" ? (
                    <ActivityIndicator color={colors.primaryForeground} />
                  ) : (
                    <Text style={[styles.worktreePrimaryText, { color: colors.primaryForeground }]}>
                      Create worktree thread
                    </Text>
                  )}
                </Pressable>

                {gitBranches?.branches.some((branch) => branch.worktreePath) ? (
                  <View style={styles.worktreeList}>
                    {gitBranches.branches
                      .filter((branch) => branch.worktreePath)
                      .map((branch) => (
                        <View
                          key={`${branch.name}-${branch.worktreePath}`}
                          style={[
                            styles.worktreeRow,
                            {
                              backgroundColor: colors.surfaceSecondary,
                              borderColor: colors.elevatedBorder,
                            },
                          ]}
                        >
                          <View style={styles.worktreeCopy}>
                            <Text
                              style={[styles.worktreeBranch, { color: colors.foreground }]}
                              numberOfLines={1}
                            >
                              {branch.name}
                            </Text>
                            <Text
                              style={[styles.worktreePath, { color: colors.secondaryLabel }]}
                              numberOfLines={1}
                            >
                              {branch.worktreePath}
                            </Text>
                          </View>
                          {branch.worktreePath ? (
                            <Pressable
                              disabled={removingWorktreePath === branch.worktreePath}
                              onPress={() => removeWorktree(branch.worktreePath!)}
                              style={styles.worktreeRemoveButton}
                            >
                              {removingWorktreePath === branch.worktreePath ? (
                                <ActivityIndicator color={colors.red} />
                              ) : (
                                <Trash2 size={15} color={colors.red} strokeWidth={2.1} />
                              )}
                            </Pressable>
                          ) : null}
                        </View>
                      ))}
                  </View>
                ) : null}
              </View>

              <View style={styles.prPanel}>
                <View style={styles.gitTitleRow}>
                  <GitPullRequest size={16} color={colors.primary} strokeWidth={2.1} />
                  <View>
                    <Text style={[styles.worktreeTitle, { color: colors.foreground }]}>
                      Pull Request Thread
                    </Text>
                    <Text style={[styles.worktreeMeta, { color: colors.secondaryLabel }]}>
                      Checkout a PR locally or in a dedicated worktree
                    </Text>
                  </View>
                </View>
                <TextInput
                  value={prReference}
                  onChangeText={(value) => {
                    setPrReference(value);
                    setResolvedPr(null);
                  }}
                  placeholder="PR URL, number, or #42"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[
                    styles.worktreeInput,
                    {
                      color: colors.foreground,
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                />
                {resolvedPr ? (
                  <View
                    style={[
                      styles.prResolvedCard,
                      {
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.elevatedBorder,
                      },
                    ]}
                  >
                    <Text style={[styles.worktreeBranch, { color: colors.foreground }]}>
                      #{resolvedPr.number} {resolvedPr.title}
                    </Text>
                    <Text style={[styles.worktreeMeta, { color: colors.secondaryLabel }]}>
                      {resolvedPr.headBranch} to {resolvedPr.baseBranch} · {resolvedPr.state}
                    </Text>
                  </View>
                ) : null}
                <View style={styles.gitActions}>
                  <Pressable
                    disabled={preparingPrMode !== null || prReference.trim().length === 0}
                    onPress={() => void resolvePullRequest()}
                    style={[
                      styles.gitActionButton,
                      {
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.elevatedBorder,
                      },
                      (preparingPrMode !== null || prReference.trim().length === 0) &&
                        styles.disabled,
                    ]}
                  >
                    <Text style={[styles.gitActionText, { color: colors.foreground }]}>
                      {preparingPrMode === "local" ? "Resolving..." : "Resolve"}
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={preparingPrMode !== null || prReference.trim().length === 0}
                    onPress={() => void preparePullRequestThread("local")}
                    style={[
                      styles.gitActionButton,
                      {
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.elevatedBorder,
                      },
                      (preparingPrMode !== null || prReference.trim().length === 0) &&
                        styles.disabled,
                    ]}
                  >
                    <Text style={[styles.gitActionText, { color: colors.foreground }]}>Local</Text>
                  </Pressable>
                  <Pressable
                    disabled={preparingPrMode !== null || prReference.trim().length === 0}
                    onPress={() => void preparePullRequestThread("worktree")}
                    style={[
                      styles.gitActionButton,
                      { backgroundColor: colors.primary, borderColor: colors.primary },
                      (preparingPrMode !== null || prReference.trim().length === 0) &&
                        styles.disabled,
                    ]}
                  >
                    <Text style={[styles.gitActionText, { color: colors.primaryForeground }]}>
                      Worktree
                    </Text>
                  </Pressable>
                </View>
              </View>

              {gitStatus?.workingTree.files.length ? (
                <View style={styles.changedFiles}>
                  {gitStatus.workingTree.files.slice(0, 5).map((file) => (
                    <View
                      key={file.path}
                      style={[
                        styles.changedFileRow,
                        {
                          backgroundColor: colors.surfaceSecondary,
                          borderColor: colors.elevatedBorder,
                        },
                      ]}
                    >
                      <Text style={[styles.changedFileStatus, { color: colors.primary }]}>
                        {file.status ?? "M"}
                      </Text>
                      <Text
                        style={[styles.changedFilePath, { color: colors.foreground }]}
                        numberOfLines={1}
                      >
                        {file.path}
                      </Text>
                      <Text style={[styles.changedFileMeta, { color: colors.secondaryLabel }]}>
                        +{file.insertions} / -{file.deletions}
                      </Text>
                    </View>
                  ))}
                  <Pressable
                    disabled={loadingDiff}
                    onPress={() =>
                      workingTreeDiff === null
                        ? void loadWorkingTreeDiff()
                        : setWorkingTreeDiff(null)
                    }
                    style={[
                      styles.diffButton,
                      {
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.elevatedBorder,
                      },
                      loadingDiff && styles.disabled,
                    ]}
                  >
                    {loadingDiff ? (
                      <ActivityIndicator color={colors.primary} />
                    ) : (
                      <FileDiff size={15} color={colors.foreground} strokeWidth={2.1} />
                    )}
                    <Text style={[styles.gitActionText, { color: colors.foreground }]}>
                      {workingTreeDiff === null ? "View working tree diff" : "Hide diff"}
                    </Text>
                  </Pressable>
                  {workingTreeDiff !== null ? (
                    <View
                      style={[
                        styles.diffPreview,
                        {
                          backgroundColor: colors.surface,
                          borderColor: colors.elevatedBorder,
                        },
                      ]}
                    >
                      <ScrollView
                        horizontal={!diffWordWrap}
                        showsHorizontalScrollIndicator={!diffWordWrap}
                      >
                        <Text
                          style={[
                            styles.diffText,
                            { color: colors.secondaryLabel },
                            diffWordWrap && styles.diffTextWrapped,
                          ]}
                        >
                          {workingTreeDiff.trim().length > 0
                            ? workingTreeDiff
                            : "No textual diff available."}
                        </Text>
                      </ScrollView>
                    </View>
                  ) : null}
                </View>
              ) : (
                <Text style={[styles.gitMeta, { color: colors.secondaryLabel }]}>
                  Working tree is clean.
                </Text>
              )}

              <TextInput
                value={commitMessage}
                onChangeText={setCommitMessage}
                placeholder="Commit message (optional)"
                placeholderTextColor={colors.muted}
                style={[
                  styles.gitCommitInput,
                  {
                    color: colors.foreground,
                    backgroundColor: colors.surfaceSecondary,
                    borderColor: colors.elevatedBorder,
                  },
                ]}
              />

              {gitProgress ? (
                <Text style={[styles.gitProgress, { color: colors.secondaryLabel }]}>
                  {gitProgress}
                </Text>
              ) : null}

              <View style={styles.gitActions}>
                <Pressable
                  disabled={!gitStatus?.hasWorkingTreeChanges || gitAction !== null}
                  onPress={() => void runGitAction("commit")}
                  style={[
                    styles.gitActionButton,
                    {
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                    (!gitStatus?.hasWorkingTreeChanges || gitAction !== null) && styles.disabled,
                  ]}
                >
                  <GitCommit size={15} color={colors.foreground} strokeWidth={2.1} />
                  <Text style={[styles.gitActionText, { color: colors.foreground }]}>Commit</Text>
                </Pressable>
                <Pressable
                  disabled={gitAction !== null || !gitStatus || gitStatus.behindCount === 0}
                  onPress={() => void pullGit()}
                  style={[
                    styles.gitActionButton,
                    {
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                    (gitAction !== null || !gitStatus || gitStatus.behindCount === 0) &&
                      styles.disabled,
                  ]}
                >
                  <RefreshCw size={15} color={colors.foreground} strokeWidth={2.1} />
                  <Text style={[styles.gitActionText, { color: colors.foreground }]}>Pull</Text>
                </Pressable>
              </View>
              <View style={styles.gitActions}>
                {(gitStatus?.pr?.url ?? lastPrUrl) ? (
                  <Pressable
                    disabled={gitAction !== null}
                    onPress={() => void openPullRequest()}
                    style={[
                      styles.gitActionButton,
                      {
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.elevatedBorder,
                      },
                      gitAction !== null && styles.disabled,
                    ]}
                  >
                    <GitPullRequest size={15} color={colors.foreground} strokeWidth={2.1} />
                    <Text style={[styles.gitActionText, { color: colors.foreground }]}>
                      Open PR
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  disabled={gitAction !== null || !gitStatus || gitStatus.aheadCount === 0}
                  onPress={() => void runGitAction("push")}
                  style={[
                    styles.gitActionButton,
                    {
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                    (gitAction !== null || !gitStatus || gitStatus.aheadCount === 0) &&
                      styles.disabled,
                  ]}
                >
                  <CloudUpload size={15} color={colors.foreground} strokeWidth={2.1} />
                  <Text style={[styles.gitActionText, { color: colors.foreground }]}>Push</Text>
                </Pressable>
                <Pressable
                  disabled={gitAction !== null || !gitStatus || gitStatus.aheadCount === 0}
                  onPress={() => void runGitAction("create_pr")}
                  style={[
                    styles.gitActionButton,
                    { backgroundColor: colors.primary, borderColor: colors.primary },
                    (gitAction !== null || !gitStatus || gitStatus.aheadCount === 0) &&
                      styles.disabled,
                  ]}
                >
                  <GitPullRequest size={15} color={colors.primaryForeground} strokeWidth={2.1} />
                  <Text style={[styles.gitActionText, { color: colors.primaryForeground }]}>
                    Create PR
                  </Text>
                </Pressable>
              </View>
            </Panel>

            <Panel style={styles.issuesPanel}>
              <View style={styles.issuesHeader}>
                <View style={styles.issuesTitleRow}>
                  <ListTodo size={18} color={colors.primary} strokeWidth={2.1} />
                  <View>
                    <SectionTitle>GitHub Issues</SectionTitle>
                    <Text style={[styles.issueMeta, { color: colors.secondaryLabel }]}>
                      Start an agent with issue context from this repository
                    </Text>
                  </View>
                </View>
                <Pressable
                  disabled={loadingIssues}
                  onPress={() => void loadIssues()}
                  style={styles.gitRefreshButton}
                >
                  {loadingIssues ? (
                    <ActivityIndicator color={colors.primary} />
                  ) : (
                    <RefreshCw size={16} color={colors.primary} strokeWidth={2.2} />
                  )}
                </Pressable>
              </View>

              <View style={styles.issueSearchRow}>
                <TextInput
                  value={issueQuery}
                  onChangeText={setIssueQuery}
                  placeholder={`Search ${issueStateFilter} issues`}
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[
                    styles.issueSearchInput,
                    {
                      color: colors.foreground,
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                />
                <Pressable
                  disabled={loadingIssues}
                  onPress={() => void loadIssues()}
                  style={[
                    styles.issueSearchButton,
                    {
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                    loadingIssues && styles.disabled,
                  ]}
                >
                  <Text style={[styles.issueSearchText, { color: colors.foreground }]}>Search</Text>
                </Pressable>
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.issueFilterStrip}
              >
                {ISSUE_STATE_OPTIONS.map((option) => {
                  const active = issueStateFilter === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      disabled={loadingIssues}
                      onPress={() => {
                        setIssueStateFilter(option.value);
                        setSelectedIssueNumbers([]);
                      }}
                      style={[
                        styles.issueFilterChip,
                        {
                          backgroundColor: active ? colors.primary : colors.surfaceSecondary,
                          borderColor: active ? colors.primary : colors.elevatedBorder,
                        },
                        loadingIssues && styles.disabled,
                      ]}
                    >
                      <Text
                        style={[
                          styles.issueFilterText,
                          { color: active ? colors.primaryForeground : colors.foreground },
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {availableIssueLabels.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.issueFilterStrip}
                >
                  {availableIssueLabels.map((entry) => {
                    const active = issueLabelFilters.includes(entry.label);
                    return (
                      <Pressable
                        key={entry.label}
                        disabled={loadingIssues}
                        onPress={() => {
                          toggleIssueLabelFilter(entry.label);
                          setSelectedIssueNumbers([]);
                        }}
                        style={[
                          styles.issueLabelChip,
                          {
                            backgroundColor: active ? colors.primary : colors.surfaceSecondary,
                            borderColor: active ? colors.primary : colors.elevatedBorder,
                          },
                          loadingIssues && styles.disabled,
                        ]}
                      >
                        <Text
                          style={[
                            styles.issueFilterText,
                            { color: active ? colors.primaryForeground : colors.foreground },
                          ]}
                        >
                          {entry.count > 0 ? `${entry.label} ${entry.count}` : entry.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              ) : null}

              {issueError ? (
                <Text style={[styles.errorText, { color: colors.red }]}>{issueError}</Text>
              ) : null}

              {issues.length > 0 ? (
                <View style={styles.issueSelectionBar}>
                  <Pressable
                    disabled={loadingIssues || startingIssueNumbers.length > 0}
                    onPress={selectAllVisibleIssues}
                    style={[
                      styles.issueSelectionButton,
                      {
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.elevatedBorder,
                      },
                      (loadingIssues || startingIssueNumbers.length > 0) && styles.disabled,
                    ]}
                  >
                    <Text style={[styles.issueSelectionText, { color: colors.foreground }]}>
                      {selectedVisibleIssueNumbers.length === visibleIssueNumbers.length
                        ? "Clear visible"
                        : "Select visible"}
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={
                      selectedVisibleIssueNumbers.length === 0 || startingIssueNumbers.length > 0
                    }
                    onPress={() => void startIssueThread(selectedVisibleIssueNumbers)}
                    style={[
                      styles.issueSelectionPrimaryButton,
                      { backgroundColor: colors.primary },
                      (selectedVisibleIssueNumbers.length === 0 ||
                        startingIssueNumbers.length > 0) &&
                        styles.disabled,
                    ]}
                  >
                    {startingIssueNumbers.length > 1 ? (
                      <ActivityIndicator color={colors.primaryForeground} />
                    ) : (
                      <Text
                        style={[
                          styles.issueSelectionPrimaryText,
                          { color: colors.primaryForeground },
                        ]}
                      >
                        {selectedVisibleIssueNumbers.length > 0
                          ? `Solve ${selectedVisibleIssueNumbers.length}`
                          : "Solve selected"}
                      </Text>
                    )}
                  </Pressable>
                </View>
              ) : null}

              {issues.length === 0 ? (
                <Text style={[styles.issueMeta, { color: colors.secondaryLabel }]}>
                  {loadingIssues ? "Loading issues..." : `No ${issueStateFilter} issues found.`}
                </Text>
              ) : (
                <View style={styles.issueList}>
                  {issues.slice(0, 8).map((issue) => {
                    const isStarting = startingIssueNumbers.includes(issue.number);
                    const isSelected = selectedIssueNumbers.includes(issue.number);
                    return (
                      <View
                        key={issue.number}
                        style={[
                          styles.issueRow,
                          {
                            backgroundColor: colors.surfaceSecondary,
                            borderColor: colors.elevatedBorder,
                          },
                        ]}
                      >
                        <Pressable
                          disabled={startingIssueNumbers.length > 0}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: isSelected }}
                          onPress={() => toggleIssueSelection(issue.number)}
                          style={[
                            styles.issueSelectButton,
                            {
                              backgroundColor: isSelected ? colors.primary : colors.surface,
                              borderColor: isSelected ? colors.primary : colors.elevatedBorder,
                            },
                            startingIssueNumbers.length > 0 && styles.disabled,
                          ]}
                        >
                          {isSelected ? (
                            <Check size={17} color={colors.primaryForeground} strokeWidth={2.6} />
                          ) : null}
                        </Pressable>
                        <Pressable
                          onPress={() => void Linking.openURL(issue.url)}
                          style={styles.issueCopy}
                        >
                          <Text style={[styles.issueTitle, { color: colors.foreground }]}>
                            #{issue.number} {issue.title}
                          </Text>
                          <Text
                            style={[styles.issueBody, { color: colors.secondaryLabel }]}
                            numberOfLines={2}
                          >
                            {issue.body?.trim() || "No description provided."}
                          </Text>
                          {issue.labels.length > 0 ? (
                            <Text
                              style={[styles.issueLabels, { color: colors.tertiaryLabel }]}
                              numberOfLines={1}
                            >
                              {issue.labels.map((label) => label.name).join(", ")}
                            </Text>
                          ) : null}
                        </Pressable>
                        <Pressable
                          disabled={isStarting || startingIssueNumbers.length > 0}
                          onPress={() => void startIssueThread([issue.number])}
                          style={[
                            styles.issueStartButton,
                            { backgroundColor: colors.primary },
                            (isStarting || startingIssueNumbers.length > 0) && styles.disabled,
                          ]}
                        >
                          {isStarting ? (
                            <ActivityIndicator color={colors.primaryForeground} />
                          ) : (
                            <Text
                              style={[styles.issueStartText, { color: colors.primaryForeground }]}
                            >
                              Solve
                            </Text>
                          )}
                        </Pressable>
                      </View>
                    );
                  })}
                </View>
              )}
            </Panel>

            <Panel style={styles.scriptsPanel}>
              <View style={styles.scriptsHeader}>
                <View>
                  <SectionTitle>Scripts</SectionTitle>
                  <Text style={[styles.scriptMeta, { color: colors.secondaryLabel }]}>
                    Run repeatable project commands on {entry.hostName}
                  </Text>
                </View>
                {savingScript ? <ActivityIndicator color={colors.primary} /> : null}
              </View>

              {entry.project.scripts.length > 0 ? (
                <View style={styles.scriptList}>
                  {entry.project.scripts.map((script) => (
                    <View
                      key={script.id}
                      style={[
                        styles.scriptRow,
                        {
                          backgroundColor: colors.surfaceSecondary,
                          borderColor: colors.elevatedBorder,
                        },
                      ]}
                    >
                      <Pressable
                        disabled={savingScript}
                        onPress={() => runScript(script)}
                        style={[styles.scriptRunButton, savingScript && styles.disabled]}
                      >
                        <Play size={15} color={colors.primary} fill={colors.primary} />
                      </Pressable>
                      <View style={styles.scriptCopy}>
                        <Text style={[styles.scriptName, { color: colors.foreground }]}>
                          {script.runOnWorktreeCreate ? `${script.name} (setup)` : script.name}
                        </Text>
                        <Text
                          style={[styles.scriptCommand, { color: colors.secondaryLabel }]}
                          numberOfLines={1}
                        >
                          {script.command}
                        </Text>
                      </View>
                      <Pressable
                        disabled={savingScript}
                        onPress={() => editScript(script)}
                        style={[styles.scriptIconButton, savingScript && styles.disabled]}
                      >
                        <Pencil size={15} color={colors.secondaryLabel} strokeWidth={2.1} />
                      </Pressable>
                      <Pressable
                        disabled={savingScript}
                        onPress={() => deleteScript(script.id)}
                        style={[styles.scriptIconButton, savingScript && styles.disabled]}
                      >
                        <Trash2 size={15} color={colors.red} strokeWidth={2.1} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={[styles.scriptMeta, { color: colors.secondaryLabel }]}>
                  No scripts configured yet.
                </Text>
              )}

              <View style={styles.scriptForm}>
                <TextInput
                  value={scriptName}
                  onChangeText={setScriptName}
                  placeholder="Script name"
                  placeholderTextColor={colors.muted}
                  style={[
                    styles.scriptInput,
                    {
                      color: colors.foreground,
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                />
                <TextInput
                  value={scriptCommand}
                  onChangeText={setScriptCommand}
                  placeholder="Command"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[
                    styles.scriptInput,
                    {
                      color: colors.foreground,
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                />
                <Pressable
                  onPress={() => setScriptRunsOnSetup((current) => !current)}
                  style={[
                    styles.setupToggle,
                    {
                      backgroundColor: scriptRunsOnSetup
                        ? withAlpha(colors.primary, 0.12)
                        : colors.surfaceSecondary,
                      borderColor: scriptRunsOnSetup
                        ? withAlpha(colors.primary, 0.38)
                        : colors.elevatedBorder,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.setupToggleText,
                      { color: scriptRunsOnSetup ? colors.primary : colors.secondaryLabel },
                    ]}
                  >
                    Run after worktree create
                  </Text>
                </Pressable>
              </View>

              {scriptError ? (
                <Text style={[styles.errorText, { color: colors.red }]}>{scriptError}</Text>
              ) : null}

              <View style={styles.scriptActions}>
                {editingScriptId ? (
                  <Pressable
                    onPress={resetScriptForm}
                    style={[
                      styles.cancelScriptButton,
                      {
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.elevatedBorder,
                      },
                    ]}
                  >
                    <Text style={[styles.cancelScriptText, { color: colors.foreground }]}>
                      Cancel
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => void saveScript()}
                  disabled={savingScript}
                  style={[
                    styles.saveScriptButton,
                    { backgroundColor: colors.primary },
                    savingScript && styles.disabled,
                  ]}
                >
                  <Text style={[styles.saveScriptText, { color: colors.primaryForeground }]}>
                    {editingScriptId ? "Update script" : "Add script"}
                  </Text>
                </Pressable>
              </View>
            </Panel>

            {showNewThread ? (
              <Panel style={styles.composerPanel}>
                <View style={styles.composerHeader}>
                  <View style={styles.composerTitleRow}>
                    <View
                      style={[
                        styles.composerIcon,
                        { backgroundColor: withAlpha(colors.primary, 0.14) },
                      ]}
                    >
                      <Bot size={18} color={colors.primary} strokeWidth={2.1} />
                    </View>
                    <View style={styles.composerTitleCopy}>
                      <Text style={[styles.composerTitle, { color: colors.foreground }]}>
                        Start agent
                      </Text>
                      <Text style={[styles.composerMeta, { color: colors.secondaryLabel }]}>
                        {connection?.status.kind === "connected"
                          ? `Runs on ${entry.hostName}`
                          : "Host is offline"}
                      </Text>
                    </View>
                  </View>
                  {creating ? <ActivityIndicator color={colors.primary} /> : null}
                </View>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.providerStrip}
                >
                  {selectableProviders.map((provider) => {
                    const selected = provider.provider === selectedProvider;
                    return (
                      <Pressable
                        key={provider.provider}
                        onPress={() => {
                          setSelectedProvider(provider.provider);
                          setSelectedModel(null);
                        }}
                        style={[
                          styles.providerChip,
                          {
                            backgroundColor: selected
                              ? withAlpha(colors.primary, 0.12)
                              : colors.surfaceSecondary,
                            borderColor: selected
                              ? withAlpha(colors.primary, 0.38)
                              : colors.elevatedBorder,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.providerLabel,
                            { color: selected ? colors.primary : colors.secondaryLabel },
                          ]}
                        >
                          {PROVIDER_DISPLAY_NAMES[provider.provider]}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>

                {selectableModels.length > 0 ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.modelStrip}
                  >
                    {selectableModels.map((model) => {
                      const selected = model.slug === selectedModel;
                      return (
                        <Pressable
                          key={model.slug}
                          onPress={() => setSelectedModel(model.slug)}
                          style={[
                            styles.modelChip,
                            {
                              backgroundColor: selected
                                ? withAlpha(colors.primary, 0.12)
                                : colors.surfaceSecondary,
                              borderColor: selected
                                ? withAlpha(colors.primary, 0.38)
                                : colors.elevatedBorder,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.modelLabel,
                              { color: selected ? colors.primary : colors.secondaryLabel },
                            ]}
                            numberOfLines={1}
                          >
                            {model.name || model.slug}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                ) : null}

                <View style={styles.modeGrid}>
                  <View style={styles.modeGroup}>
                    <Text style={[styles.modeGroupLabel, { color: colors.tertiaryLabel }]}>
                      Access
                    </Text>
                    <View style={styles.modeRow}>
                      {RUNTIME_OPTIONS.map((option) => {
                        const selected = option.value === runtimeMode;
                        return (
                          <Pressable
                            key={option.value}
                            onPress={() => setRuntimeMode(option.value)}
                            style={[
                              styles.modeChip,
                              {
                                backgroundColor: selected
                                  ? withAlpha(colors.primary, 0.12)
                                  : colors.surfaceSecondary,
                                borderColor: selected
                                  ? withAlpha(colors.primary, 0.38)
                                  : colors.elevatedBorder,
                              },
                            ]}
                          >
                            <Text
                              style={[
                                styles.modeChipLabel,
                                { color: selected ? colors.primary : colors.foreground },
                              ]}
                            >
                              {option.label}
                            </Text>
                            <Text
                              style={[styles.modeChipDescription, { color: colors.secondaryLabel }]}
                            >
                              {option.description}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>

                  <View style={styles.modeGroup}>
                    <Text style={[styles.modeGroupLabel, { color: colors.tertiaryLabel }]}>
                      Mode
                    </Text>
                    <View style={styles.modeRow}>
                      {INTERACTION_OPTIONS.map((option) => {
                        const selected = option.value === interactionMode;
                        return (
                          <Pressable
                            key={option.value}
                            onPress={() => setInteractionMode(option.value)}
                            style={[
                              styles.modeChip,
                              {
                                backgroundColor: selected
                                  ? withAlpha(colors.primary, 0.12)
                                  : colors.surfaceSecondary,
                                borderColor: selected
                                  ? withAlpha(colors.primary, 0.38)
                                  : colors.elevatedBorder,
                              },
                            ]}
                          >
                            <Text
                              style={[
                                styles.modeChipLabel,
                                { color: selected ? colors.primary : colors.foreground },
                              ]}
                            >
                              {option.label}
                            </Text>
                            <Text
                              style={[styles.modeChipDescription, { color: colors.secondaryLabel }]}
                            >
                              {option.description}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                </View>

                <TextInput
                  value={prompt}
                  onChangeText={setPrompt}
                  placeholder="Describe the task for this agent"
                  placeholderTextColor={colors.muted}
                  multiline
                  style={[
                    styles.promptInput,
                    {
                      color: colors.foreground,
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                />

                <ImageAttachmentCapture
                  images={composerImages}
                  onImagesChange={setComposerImages}
                  disabled={creating}
                />

                {composerError ? (
                  <Text style={[styles.errorText, { color: colors.red }]}>{composerError}</Text>
                ) : null}

                <Pressable
                  onPress={() => void createThread()}
                  disabled={creating || connection?.status.kind !== "connected"}
                  style={[
                    styles.createButton,
                    { backgroundColor: colors.primary },
                    (creating || connection?.status.kind !== "connected") && styles.disabled,
                  ]}
                >
                  <Text style={[styles.createButtonText, { color: colors.primaryForeground }]}>
                    {prompt.trim().length > 0 || composerImages.length > 0
                      ? "Create and run"
                      : "Create empty thread"}
                  </Text>
                </Pressable>
              </Panel>
            ) : null}
          </>
        ) : null}

        <View style={styles.sectionHeader}>
          <SectionTitle>Threads</SectionTitle>
          <Text style={[styles.sectionMeta, { color: colors.tertiaryLabel }]}>
            {projectThreads.length} total
          </Text>
        </View>

        {projectThreads.length === 0 ? (
          <EmptyState
            title="No threads yet"
            body="This project will populate once a thread starts on the connected host."
          />
        ) : (
          <Panel padded={false} style={styles.listShell}>
            {projectThreads.map((thread, index) => (
              <Pressable
                key={`${thread.hostId}-${thread.thread.id}`}
                onPress={() =>
                  router.push({
                    pathname: "/thread/[threadId]",
                    params: { threadId: thread.thread.id, hostId: thread.hostId },
                  })
                }
                style={({ pressed }) => [
                  styles.threadRow,
                  {
                    backgroundColor: pressed ? withAlpha(colors.foreground, 0.04) : "transparent",
                  },
                ]}
              >
                <View style={styles.threadCopy}>
                  <View style={styles.threadTitleRow}>
                    <Text
                      style={[styles.threadTitle, { color: colors.foreground }]}
                      numberOfLines={1}
                    >
                      {thread.thread.title}
                    </Text>
                    <StatusBadge label={thread.status.label} tone={thread.status.tone} />
                  </View>
                  <Text
                    style={[styles.threadPreview, { color: colors.secondaryLabel }]}
                    numberOfLines={2}
                  >
                    {thread.preview}
                  </Text>
                  <Text
                    style={[styles.threadMeta, { color: colors.tertiaryLabel }]}
                    numberOfLines={1}
                  >
                    {thread.hostName} · {formatTimeAgo(thread.lastActivityAt)}
                  </Text>
                </View>
                {index < projectThreads.length - 1 ? (
                  <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                ) : null}
              </Pressable>
            ))}
          </Panel>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  backButton: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.14,
    shadowRadius: 28,
    elevation: 0,
  },
  headerCopy: {
    flex: 1,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.34,
    textTransform: "uppercase",
  },
  title: {
    marginTop: 8,
    fontSize: 32,
    lineHeight: 34,
    fontWeight: "800",
    letterSpacing: -1.1,
  },
  subtitle: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 20,
  },
  heroPanel: {
    marginTop: 22,
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  heroIcon: {
    width: 46,
    height: 46,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  heroCopy: {
    flex: 1,
  },
  heroLabel: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.24,
  },
  heroPath: {
    marginTop: 8,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "600",
  },
  filesButton: {
    marginTop: 18,
    minHeight: 48,
    borderRadius: Radius.input,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
  filesButtonText: {
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
  metricRow: {
    marginTop: 14,
    flexDirection: "row",
    gap: 10,
  },
  projectSettingsPanel: {
    marginTop: 16,
  },
  settingsHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  settingsMeta: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 18,
  },
  settingsInput: {
    marginTop: 14,
    minHeight: 54,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 15,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
  },
  settingsActions: {
    marginTop: 16,
    flexDirection: "row",
    gap: 10,
  },
  settingsPrimaryButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: Radius.card,
    alignItems: "center",
    justifyContent: "center",
  },
  settingsSecondaryButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: Radius.card,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  deleteProjectButton: {
    marginTop: 10,
    minHeight: 46,
    borderRadius: Radius.card,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  settingsButtonText: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
    letterSpacing: -0.16,
  },
  gitPanel: {
    marginTop: 16,
  },
  gitHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  gitTitleRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  gitMeta: {
    marginTop: 5,
    fontSize: 13,
    lineHeight: 18,
  },
  gitRefreshButton: {
    width: 36,
    height: 36,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  branchStrip: {
    gap: 8,
    paddingTop: 14,
    paddingBottom: 2,
  },
  branchChip: {
    minHeight: 36,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  branchChipText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  branchCreateRow: {
    marginTop: 12,
    flexDirection: "row",
    gap: 10,
  },
  branchCreateInput: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 12,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
  branchCreateButton: {
    minHeight: 44,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  branchCreateText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },
  worktreePanel: {
    marginTop: 14,
    gap: 10,
  },
  worktreeHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  worktreeTitle: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "800",
    letterSpacing: -0.15,
  },
  worktreeMeta: {
    marginTop: 3,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
  },
  worktreeInput: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 12,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
  worktreePrimaryButton: {
    minHeight: 44,
    borderRadius: Radius.input,
    alignItems: "center",
    justifyContent: "center",
  },
  worktreePrimaryText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },
  worktreeList: {
    gap: 8,
  },
  worktreeRow: {
    minHeight: 48,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingLeft: 12,
    paddingRight: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  worktreeCopy: {
    flex: 1,
    minWidth: 0,
  },
  worktreeBranch: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },
  worktreePath: {
    marginTop: 2,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
  },
  worktreeRemoveButton: {
    width: 38,
    height: 38,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  prPanel: {
    marginTop: 14,
    gap: 10,
  },
  prResolvedCard: {
    borderWidth: 1,
    borderRadius: Radius.input,
    padding: 12,
  },
  changedFiles: {
    marginTop: 12,
    gap: 8,
  },
  changedFileRow: {
    minHeight: 42,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  changedFileStatus: {
    width: 18,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "900",
    textAlign: "center",
  },
  changedFilePath: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
  changedFileMeta: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
  },
  diffButton: {
    minHeight: 44,
    borderRadius: Radius.input,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  diffPreview: {
    maxHeight: 320,
    borderRadius: Radius.input,
    borderWidth: 1,
    padding: 12,
    overflow: "hidden",
  },
  diffText: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 11,
    lineHeight: 16,
  },
  diffTextWrapped: {
    flexShrink: 1,
  },
  gitCommitInput: {
    marginTop: 14,
    minHeight: 46,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 13,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "600",
  },
  gitProgress: {
    marginTop: 10,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "700",
  },
  gitActions: {
    marginTop: 10,
    flexDirection: "row",
    gap: 10,
  },
  gitActionButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: Radius.input,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  initGitButton: {
    marginTop: 12,
    minHeight: 46,
    borderRadius: Radius.input,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  gitActionText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },
  issuesPanel: {
    marginTop: 16,
  },
  issuesHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  issuesTitleRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  issueMeta: {
    marginTop: 5,
    fontSize: 13,
    lineHeight: 18,
  },
  issueSearchRow: {
    marginTop: 14,
    flexDirection: "row",
    gap: 10,
  },
  issueSearchInput: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 12,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
  issueSearchButton: {
    minHeight: 44,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  issueSearchText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },
  issueFilterStrip: {
    gap: 8,
    paddingTop: 12,
    paddingBottom: 2,
  },
  issueFilterChip: {
    minHeight: 38,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  issueLabelChip: {
    minHeight: 36,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  issueFilterText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  issueSelectionBar: {
    marginTop: 12,
    flexDirection: "row",
    gap: 10,
  },
  issueSelectionButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: Radius.input,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  issueSelectionPrimaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: Radius.input,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  issueSelectionText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },
  issueSelectionPrimaryText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "900",
  },
  issueList: {
    marginTop: 12,
    gap: 10,
  },
  issueRow: {
    minHeight: 96,
    borderRadius: Radius.input,
    borderWidth: 1,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  issueSelectButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  issueCopy: {
    flex: 1,
    minWidth: 0,
  },
  issueTitle: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "800",
    letterSpacing: -0.12,
  },
  issueBody: {
    marginTop: 5,
    fontSize: 12,
    lineHeight: 17,
  },
  issueLabels: {
    marginTop: 6,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "700",
  },
  issueStartButton: {
    minWidth: 68,
    minHeight: 40,
    borderRadius: Radius.input,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  issueStartText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "900",
  },
  scriptsPanel: {
    marginTop: 16,
  },
  scriptsHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  scriptMeta: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 18,
  },
  scriptList: {
    marginTop: 14,
    gap: 10,
  },
  scriptRow: {
    minHeight: 62,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  scriptRunButton: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  scriptCopy: {
    flex: 1,
    minWidth: 0,
  },
  scriptName: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
    letterSpacing: -0.12,
  },
  scriptCommand: {
    marginTop: 3,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
  },
  scriptIconButton: {
    width: 32,
    height: 32,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  scriptForm: {
    marginTop: 14,
    gap: 9,
  },
  scriptInput: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 13,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "600",
  },
  setupToggle: {
    minHeight: 42,
    borderRadius: Radius.input,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  setupToggleText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
    letterSpacing: -0.08,
  },
  scriptActions: {
    marginTop: 14,
    flexDirection: "row",
    gap: 10,
  },
  cancelScriptButton: {
    minHeight: 46,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelScriptText: {
    fontSize: 14,
    fontWeight: "800",
  },
  saveScriptButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: Radius.input,
    alignItems: "center",
    justifyContent: "center",
  },
  saveScriptText: {
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
  composerPanel: {
    marginTop: 16,
  },
  composerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  composerTitleRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  composerIcon: {
    width: 42,
    height: 42,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  composerTitleCopy: {
    flex: 1,
  },
  composerTitle: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  composerMeta: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
  },
  providerStrip: {
    gap: 9,
    paddingTop: 16,
    paddingBottom: 2,
  },
  providerChip: {
    minHeight: 40,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  providerLabel: {
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
  modelStrip: {
    gap: 8,
    paddingTop: 10,
    paddingBottom: 2,
  },
  modelChip: {
    maxWidth: 220,
    minHeight: 38,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  modelLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
    letterSpacing: -0.08,
  },
  modeGrid: {
    marginTop: 14,
    gap: 12,
  },
  modeGroup: {
    gap: 8,
  },
  modeGroupLabel: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  modeRow: {
    flexDirection: "row",
    gap: 9,
  },
  modeChip: {
    flex: 1,
    minHeight: 58,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    justifyContent: "center",
  },
  modeChipLabel: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
    letterSpacing: -0.18,
  },
  modeChipDescription: {
    marginTop: 3,
    fontSize: 12,
    lineHeight: 16,
  },
  promptInput: {
    marginTop: 14,
    minHeight: 106,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: "500",
    textAlignVertical: "top",
  },
  errorText: {
    marginTop: 12,
    fontSize: 13,
    lineHeight: 18,
  },
  createButton: {
    marginTop: 16,
    minHeight: 52,
    borderRadius: Radius.card,
    alignItems: "center",
    justifyContent: "center",
  },
  createButtonText: {
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: -0.2,
  },
  disabled: {
    opacity: 0.58,
  },
  sectionHeader: {
    marginTop: 24,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionMeta: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  listShell: {
    overflow: "hidden",
  },
  threadRow: {
    minHeight: 104,
    paddingHorizontal: 18,
    paddingVertical: 18,
  },
  threadCopy: {
    flex: 1,
  },
  threadTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  threadTitle: {
    flex: 1,
    fontSize: 19,
    lineHeight: 23,
    fontWeight: "800",
    letterSpacing: -0.45,
  },
  threadPreview: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 20,
  },
  threadMeta: {
    marginTop: 10,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "700",
  },
  separator: {
    position: "absolute",
    bottom: 0,
    left: 18,
    right: 18,
    height: StyleSheet.hairlineWidth,
  },
});
