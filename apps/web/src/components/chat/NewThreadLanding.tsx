import { type ProjectId, type ThreadId } from "@ace/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  FolderIcon,
  GitBranchIcon,
  LaptopIcon,
  LayersIcon,
  MicIcon,
  PlusIcon,
  ShieldCheckIcon,
  SparklesIcon,
  CodeIcon,
  ListTodoIcon,
  LayoutIcon,
} from "lucide-react";
import { useCallback, useMemo, useState, useRef } from "react";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useSetting, useSettings } from "~/hooks/useSettings";
import { APP_WORKSPACE_CLASS_NAME } from "~/lib/appChrome";
import { resolveSidebarNewThreadOptions } from "~/lib/sidebar";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { useSidebarThreadSummariesByProjectId } from "~/storeSelectors";
import { useServerConfig } from "~/rpc/serverState";
import { resolveAppModelSelectionState } from "~/modelSelection";
import { formatProviderModelDisplayName } from "@ace/shared/model";
import { gitStatusQueryOptions } from "~/lib/gitReactQuery";
import { useComposerDraftStore, type DraftThreadEnvMode } from "~/composerDraftStore";
import { newThreadId } from "~/lib/utils";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "~/components/ComposerPromptEditor";
import { type TerminalContextDraft } from "~/lib/terminalContext";

import { AppPageTopBar } from "../AppPageTopBar";
import { Button } from "../ui/button";
import { ProjectContextSwitcher } from "./ProjectContextSwitcher";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { HEADER_PILL_TRIGGER_CLASS_NAME } from "../thread/topBarClusterStyles";

export function NewThreadLanding() {
  const projects = useStore((store) => store.projects);
  const activeProjects = useMemo(
    () => projects.filter((project) => project.archivedAt === null),
    [projects],
  );
  const { defaultProjectId, handleNewThread } = useHandleNewThread();
  const defaultThreadEnvMode = useSetting("defaultThreadEnvMode");
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(defaultProjectId);
  const activeProjectId = useMemo(() => {
    if (
      selectedProjectId !== null &&
      activeProjects.some((project) => project.id === selectedProjectId)
    ) {
      return selectedProjectId;
    }
    return defaultProjectId;
  }, [activeProjects, defaultProjectId, selectedProjectId]);

  const activeProject = useMemo(
    () => activeProjects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, activeProjects],
  );
  const hasProjects = activeProjects.length > 0;

  // Local state for prompt, cursor and environment mode
  const [promptState, setPromptState] = useState("");
  const [cursor, setCursor] = useState(0);
  const [envMode, setEnvMode] = useState<DraftThreadEnvMode>(defaultThreadEnvMode);

  const editorRef = useRef<ComposerPromptEditorHandle>(null);

  // Fetch Git status for the active project to get the branch name
  const branchStatusQuery = useQuery(gitStatusQueryOptions(activeProject?.cwd ?? null));
  const activeBranchName = branchStatusQuery.data?.branch ?? "main";

  // Fetch current server config & settings to resolve the text generation model name
  const serverConfig = useServerConfig();
  const settings = useSettings();
  const modelName = useMemo(() => {
    if (!serverConfig) return "Codex";
    const selection = resolveAppModelSelectionState(settings, serverConfig.providers);
    return formatProviderModelDisplayName(selection.provider, selection.model);
  }, [serverConfig, settings]);

  // Fetch past threads for recommended prompts
  const allProjectThreads = useSidebarThreadSummariesByProjectId(activeProjectId);

  const recommendedPrompts = useMemo(() => {
    const defaults = [
      {
        title: "Refactor components",
        description: "Improve code structure, readability, and performance of existing components.",
        prompt:
          "Refactor the core React components in this project to follow clean code guidelines, extract common hooks, and improve performance.",
        icon: CodeIcon,
        iconBg: "bg-blue-500/10 text-blue-400 border border-blue-500/20",
      },
      {
        title: "Write unit tests",
        description: "Generate comprehensive tests using Vitest to ensure code correctness.",
        prompt:
          "Write comprehensive unit tests using Vitest and React Testing Library for the main components and utility functions in this project.",
        icon: ListTodoIcon,
        iconBg: "bg-purple-500/10 text-purple-400 border border-purple-500/20",
      },
      {
        title: "Fix UI layout & alignment",
        description: "Resolve padding, margin, flexbox alignment, and spacing issues.",
        prompt:
          "Analyze the UI layout of the project, check spacing, margins, and padding, and align elements to make the design feel premium and cohesive.",
        icon: LayoutIcon,
        iconBg: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
      },
    ];

    if (!allProjectThreads || allProjectThreads.length === 0) {
      return defaults;
    }

    const recentThreads = allProjectThreads
      .filter((t) => t.title && t.title !== "New thread")
      .slice(0, 3);

    if (recentThreads.length === 0) {
      return defaults;
    }

    return recentThreads.map((thread, index) => {
      const title = thread.title;
      const promptTemplates = [
        `Continue working on "${title}" by refactoring its core logic, fixing edge cases, and cleaning up comments.`,
        `Write unit tests specifically covering the changes made in the "${title}" task to guarantee stability.`,
        `Add responsive layout support and polish UI styling (padding/margin/theme) for the "${title}" components.`,
      ];
      const descTemplates = [
        `Refactor and extend code related to "${title}".`,
        `Write unit tests for the "${title}" implementation.`,
        `Polish visual layout and spacing for "${title}".`,
      ];
      const icons = [CodeIcon, ListTodoIcon, LayoutIcon];
      const iconBgs = [
        "bg-blue-500/10 text-blue-400 border border-blue-500/20",
        "bg-purple-500/10 text-purple-400 border border-purple-500/20",
        "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
      ];
      return {
        title: title.length > 25 ? title.substring(0, 25) + "..." : title,
        description: descTemplates[index] ?? `Follow-up work for "${title}".`,
        prompt: promptTemplates[index] ?? `Continue work on: ${title}`,
        icon: icons[index] ?? CodeIcon,
        iconBg: iconBgs[index] ?? "bg-blue-500/10 text-blue-400",
      };
    });
  }, [allProjectThreads]);

  const startNewThread = useCallback(
    (overridePrompt?: string) => {
      if (activeProjectId === null) {
        return;
      }
      const finalPrompt = overridePrompt !== undefined ? overridePrompt : promptState;

      const storedDraftThread = useComposerDraftStore
        .getState()
        .getDraftThreadByProjectId(activeProjectId);
      let targetThreadId: ThreadId;
      if (storedDraftThread) {
        targetThreadId = storedDraftThread.threadId;
      } else {
        targetThreadId = newThreadId();
        useComposerDraftStore.getState().setProjectDraftThreadId(activeProjectId, targetThreadId, {
          createdAt: new Date().toISOString(),
          branch: null,
          worktreePath: null,
          envMode: envMode,
          runtimeMode: "full-access",
        });
      }

      if (finalPrompt.trim()) {
        useComposerDraftStore.getState().setPrompt(targetThreadId, finalPrompt);
      }

      void handleNewThread(
        activeProjectId,
        resolveSidebarNewThreadOptions({
          projectId: activeProjectId,
          defaultEnvMode: envMode,
        }),
      );
    },
    [activeProjectId, promptState, envMode, handleNewThread],
  );

  const handleCommandKeyDown = useCallback(
    (key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape", event: KeyboardEvent) => {
      if (key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        startNewThread();
        return true;
      }
      return false;
    },
    [startNewThread],
  );

  const handlePromptChange = useCallback((nextValue: string, nextCursor: number) => {
    setPromptState(nextValue);
    setCursor(nextCursor);
  }, []);

  const handleCardClick = (promptText: string) => {
    setPromptState(promptText);
    setCursor(promptText.length);
    setTimeout(() => {
      editorRef.current?.focusAtEnd();
    }, 0);
  };

  const emptyTerminalContexts = useMemo<ReadonlyArray<TerminalContextDraft>>(() => [], []);
  const handleRemoveTerminalContext = useCallback(() => {}, []);
  const handlePaste = useCallback<React.ClipboardEventHandler<HTMLElement>>(() => {}, []);

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", APP_WORKSPACE_CLASS_NAME)}>
      <AppPageTopBar>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2.5">
          <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
            <span className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Start
            </span>
            <span className="truncate text-[15px] font-semibold tracking-tight text-foreground">
              New thread
            </span>
          </div>
          {activeProject ? (
            <span className="max-w-52 shrink-0 truncate text-[12px] font-medium text-muted-foreground">
              {activeProject.name}
            </span>
          ) : null}
        </div>
      </AppPageTopBar>

      <div className="flex flex-1 flex-col items-center justify-center overflow-x-hidden overflow-y-auto px-5 py-10 sm:px-10 sm:py-12">
        <section className="flex w-full max-w-3xl flex-col items-center text-center">
          {/* Centered Heading */}
          <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            {activeProject
              ? `What should we build in ${activeProject.name}?`
              : "What should we build?"}
          </h1>

          {hasProjects ? (
            <div className="mt-8 flex w-full flex-col items-center">
              {/* Premium Composer Container */}
              <div className="w-full max-w-2xl rounded-xl border border-border/60 bg-card/60 p-4 shadow-xl transition-all duration-300 focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/20 backdrop-blur-sm">
                <div className="min-h-[72px] text-left">
                  <ComposerPromptEditor
                    ref={editorRef}
                    value={promptState}
                    cursor={cursor}
                    terminalContexts={emptyTerminalContexts}
                    onRemoveTerminalContext={handleRemoveTerminalContext}
                    onChange={handlePromptChange}
                    onCommandKeyDown={handleCommandKeyDown}
                    onPaste={handlePaste}
                    placeholder="Do anything"
                    disabled={false}
                    className="text-sm/relaxed py-1 focus:ring-0 focus:outline-none min-h-[72px]"
                  />
                </div>
                <div className="mt-2 flex items-center justify-between border-t border-border/30 pt-3">
                  {/* Left inner controls */}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      className="inline-flex size-6.5 items-center justify-center rounded-full border border-border/60 bg-transparent text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground transition-colors"
                      aria-label="Add attachment"
                    >
                      <PlusIcon className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-6.5 items-center gap-1 rounded-full border border-border/60 bg-transparent px-2.5 text-[10px] font-semibold tracking-wide text-amber-500/90 dark:text-amber-400/90 hover:bg-foreground/[0.06] transition-colors"
                    >
                      <ShieldCheckIcon className="size-3.5" />
                      <span>Full access</span>
                      <ChevronDownIcon className="size-3 text-muted-foreground/60" />
                    </button>
                  </div>

                  {/* Right inner controls */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="inline-flex h-6.5 items-center gap-1 rounded-full border border-border/60 bg-transparent px-2.5 text-[10px] font-medium text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground transition-colors"
                    >
                      <SparklesIcon className="size-3.5 text-blue-400" />
                      <span>{modelName}</span>
                      <ChevronDownIcon className="size-3 text-muted-foreground/60" />
                    </button>
                    <button
                      type="button"
                      className="inline-flex size-6.5 items-center justify-center rounded-full bg-transparent text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground transition-colors"
                      aria-label="Voice input"
                    >
                      <MicIcon className="size-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => startNewThread()}
                      disabled={!promptState.trim()}
                      className={cn(
                        "inline-flex size-7 items-center justify-center rounded-full transition-all duration-200",
                        promptState.trim()
                          ? "bg-primary text-primary-foreground hover:bg-primary/95 shadow-md shadow-primary/20 hover:scale-105"
                          : "bg-muted-foreground/20 text-muted-foreground/40 cursor-not-allowed",
                      )}
                      aria-label="Submit prompt"
                    >
                      <ArrowUpIcon className="size-4" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Bottom Context Pills Toolbar */}
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {/* Project selector */}
                <ProjectContextSwitcher
                  activeProjectId={activeProjectId}
                  onSelectProject={setSelectedProjectId}
                  variant="compact"
                />

                {/* Environment Mode dropdown */}
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        className={cn(
                          HEADER_PILL_TRIGGER_CLASS_NAME,
                          "h-6.5 sm:h-7 items-center gap-1.5 !px-2.5",
                        )}
                        variant="ghost"
                        size="sm"
                      />
                    }
                  >
                    {envMode === "local" ? (
                      <LaptopIcon className="size-3.5 text-muted-foreground/80" />
                    ) : (
                      <LayersIcon className="size-3.5 text-muted-foreground/80" />
                    )}
                    <span className="text-[10px]/none font-medium">
                      {envMode === "local" ? "Work locally" : "Work in worktree"}
                    </span>
                    <ChevronDownIcon className="size-3 text-muted-foreground/50" />
                  </MenuTrigger>
                  <MenuPopup align="start" className="w-48">
                    <MenuGroup>
                      <MenuRadioGroup
                        value={envMode}
                        onValueChange={(val) => setEnvMode(val as DraftThreadEnvMode)}
                      >
                        <MenuRadioItem value="local" className="text-xs">
                          <span className="flex items-center gap-2">
                            <LaptopIcon className="size-3.5" />
                            Work locally
                          </span>
                        </MenuRadioItem>
                        <MenuRadioItem value="worktree" className="text-xs">
                          <span className="flex items-center gap-2">
                            <LayersIcon className="size-3.5" />
                            Work in worktree
                          </span>
                        </MenuRadioItem>
                      </MenuRadioGroup>
                    </MenuGroup>
                  </MenuPopup>
                </Menu>

                {/* Git branch name badge/pill */}
                <div
                  className={cn(
                    HEADER_PILL_TRIGGER_CLASS_NAME,
                    "h-6.5 sm:h-7 inline-flex items-center gap-1.5 !px-2.5 select-none",
                  )}
                >
                  <GitBranchIcon className="size-3.5 text-muted-foreground/80" />
                  <span className="text-[10px]/none font-medium truncate max-w-40">
                    {activeBranchName}
                  </span>
                  <ChevronDownIcon className="size-3 text-muted-foreground/30" />
                </div>
              </div>

              {/* Recommended Prompts Section */}
              <div className="mt-12 w-full max-w-4xl border-t border-border/20 pt-8 flex flex-col items-center">
                <span className="text-[10px] font-semibold tracking-[0.15em] text-muted-foreground/60 uppercase mb-4">
                  Recommended prompts for {activeProject?.name ?? ""}
                </span>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full mt-2">
                  {recommendedPrompts.map((rec, i) => {
                    const IconComponent = rec.icon;
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => handleCardClick(rec.prompt)}
                        className="flex flex-col items-start text-left p-4 rounded-xl border border-border/40 bg-card/20 hover:bg-card/45 hover:border-primary/25 transition-all duration-200 cursor-pointer group hover:scale-[1.01]"
                      >
                        <div className={cn("p-1.5 rounded-lg mb-3", rec.iconBg)}>
                          <IconComponent className="size-4" />
                        </div>
                        <span className="text-xs font-semibold text-foreground group-hover:text-primary transition-colors">
                          {rec.title}
                        </span>
                        <span className="text-[11px] text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                          {rec.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-8 inline-flex items-center gap-2 rounded-[var(--control-radius)] border border-dashed border-border/50 px-4 py-2.5 text-sm text-muted-foreground">
              <PlusIcon className="size-4" />
              Use the Add project button in the sidebar.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
