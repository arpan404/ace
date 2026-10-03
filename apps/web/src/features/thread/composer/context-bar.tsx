import {
  CaretDownIcon,
  FolderSimpleIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LaptopIcon,
} from "@phosphor-icons/react";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useGit } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";

const control =
  "inline-flex h-6 items-center gap-[5px] rounded-sm px-[7px] text-subtle-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground";

function Separator() {
  return <span aria-hidden className="mx-1 h-3 w-px bg-border" />;
}

/** Below the composer: where the thread runs (worktree or local), its branch and its PR. */
export function ContextBar(props: { thread: ThreadRef }) {
  const { git, change } = useGit(props.thread);
  if (!git) return <div className="h-8" />;
  return (
    <div className="flex h-8 items-center gap-0.5 px-2.5 pt-2 text-[12px] text-subtle-foreground">
      <Menu>
        <MenuTrigger
          aria-label={`Checkout: ${git.mode === "worktree" ? "Worktree" : "Local"}`}
          className={control}
        >
          {git.mode === "worktree" ? (
            <FolderSimpleIcon aria-hidden size={14} />
          ) : (
            <LaptopIcon aria-hidden size={14} />
          )}
          {git.mode === "worktree" ? "Worktree" : "Local"}
          <CaretDownIcon aria-hidden size={12} />
        </MenuTrigger>
        <MenuContent side="top">
          <MenuRadioGroup
            value={git.mode}
            onValueChange={(mode: string) =>
              void change({ kind: "mode", mode: mode === "local" ? "local" : "worktree" }).catch(
                () => {},
              )
            }
          >
            <MenuRadioItem value="worktree">Own worktree</MenuRadioItem>
            <MenuRadioItem value="local">Local checkout</MenuRadioItem>
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <Separator />
      <Menu>
        <MenuTrigger aria-label={`Branch: ${git.branch}`} className={control}>
          <GitBranchIcon aria-hidden size={14} />
          <span className="font-mono text-[11.5px]">{git.branch}</span>
          <CaretDownIcon aria-hidden size={12} />
        </MenuTrigger>
        <MenuContent side="top">
          <MenuRadioGroup
            value={git.branch}
            onValueChange={(branch: string) =>
              void change({ kind: "branch", branch }).catch(() => {})
            }
          >
            {git.branches.map((branch) => (
              <MenuRadioItem key={branch} value={branch}>
                <span className="font-mono text-[12px]">{branch}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      {git.pr && (
        <>
          <Separator />
          <Tip label="Open on GitHub">
            <a href={git.pr.url} target="_blank" rel="noreferrer noopener" className={control}>
              <GitPullRequestIcon aria-hidden size={14} />#{git.pr.number}
              <span className="text-subtle-foreground">· {git.pr.state}</span>
            </a>
          </Tip>
        </>
      )}
    </div>
  );
}
