import { type ProjectId } from "@ace/contracts";
import {
  ChevronDownIcon,
  GitBranchIcon,
  PlusIcon,
  CodeIcon,
  ListTodoIcon,
  LayoutIcon,
} from "lucide-react";
import { useMemo, type ComponentType, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useSidebarThreadSummariesByProjectId } from "~/storeSelectors";

import {
  DRAFT_CONTEXT_PILL_ICON_CLASS_NAME,
  DRAFT_CONTEXT_PILL_TRIGGER_CLASS_NAME,
} from "../thread/topBarClusterStyles";

export interface NewThreadRecommendedPrompt {
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly iconBg: string;
}

export function useNewThreadRecommendedPrompts(
  activeProjectId: ProjectId | null,
): ReadonlyArray<NewThreadRecommendedPrompt> {
  const allProjectThreads = useSidebarThreadSummariesByProjectId(activeProjectId);

  return useMemo(() => {
    const defaults: ReadonlyArray<NewThreadRecommendedPrompt> = [
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
      .filter((thread) => thread.title && thread.title !== "New thread")
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
}

interface NewThreadStartSurfaceProps {
  readonly activeProjectName: string | null;
  readonly branchName: string;
  readonly composerNode: ReactNode;
  readonly contextControlsNode: ReactNode;
  readonly hasProjects: boolean;
  readonly recommendedPrompts: ReadonlyArray<NewThreadRecommendedPrompt>;
  readonly onRecommendedPromptClick: (prompt: string) => void;
}

export function NewThreadStartSurface({
  activeProjectName,
  branchName,
  composerNode,
  contextControlsNode,
  hasProjects,
  recommendedPrompts,
  onRecommendedPromptClick,
}: NewThreadStartSurfaceProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-x-hidden overflow-y-auto px-5 py-10 sm:px-10 sm:py-12">
      <section className="flex w-full max-w-3xl flex-col items-center text-center">
        <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          {activeProjectName
            ? `What should we build in ${activeProjectName}?`
            : "What should we build?"}
        </h1>

        {hasProjects ? (
          <div className="mt-8 flex w-full flex-col items-center">
            <div className="w-full max-w-3xl text-left">{composerNode}</div>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {contextControlsNode}
              <div
                className={cn(
                  DRAFT_CONTEXT_PILL_TRIGGER_CLASS_NAME,
                  "min-w-[12rem] max-w-[18rem] select-none",
                )}
              >
                <span className={DRAFT_CONTEXT_PILL_ICON_CLASS_NAME}>
                  <GitBranchIcon className="size-4" />
                </span>
                <span className="min-w-0 truncate">{branchName}</span>
                <ChevronDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground/45" />
              </div>
            </div>

            <div className="mt-12 w-full max-w-4xl border-t border-border/20 pt-8 flex flex-col items-center">
              <span className="text-[10px] font-semibold tracking-[0.15em] text-muted-foreground/60 uppercase mb-4">
                Recommended prompts for {activeProjectName ?? ""}
              </span>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full mt-2">
                {recommendedPrompts.map((rec) => {
                  const IconComponent = rec.icon;
                  return (
                    <button
                      key={`${rec.title}:${rec.prompt}`}
                      type="button"
                      onClick={() => onRecommendedPromptClick(rec.prompt)}
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
  );
}
