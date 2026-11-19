import { setTimeout } from "node:timers/promises";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";
import { descriptorNames } from "@ace/workspace/descriptor";
import { excludedStoragePath } from "./usage-walk-roots.ts";

export interface UsageBudget {
  remaining: number;
  deadline: number;
  maxDepth: number;
  now(): number;
  cancelled(): boolean;
}
export interface UsageSize {
  bytes: number;
  items: number;
  complete: boolean;
}
export const missingUsagePath = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** All descendants are reached through pinned no-follow descriptors, including on Windows. */
export class UsageWalk {
  private budget: UsageBudget;
  private operations = 0;
  constructor(budget: UsageBudget) {
    this.budget = budget;
  }
  going(): boolean {
    return !this.budget.cancelled() && this.budget.now() < this.budget.deadline;
  }
  async step(): Promise<boolean> {
    if (++this.operations % 32 === 0) await setTimeout(1);
    if (!this.going() || this.budget.remaining <= 0) return false;
    this.budget.remaining--;
    return true;
  }
  async measure(root: PinnedDirectory, path: string, seen?: Set<string>): Promise<UsageSize> {
    const size: UsageSize = { bytes: 0, items: 0, complete: true };
    const visit = async (
      parent: PinnedDirectory,
      name: string,
      display: string,
      depth: number,
    ): Promise<void> => {
      if (excludedStoragePath(display)) return;
      if (!(await this.step())) {
        size.complete = false;
        return;
      }
      try {
        const info = parent.metadata(name);
        if ((info.mode & 0o170000) === 0o040000) {
          if (depth >= this.budget.maxDepth) {
            size.complete = false;
            return;
          }
          const directory = parent.child(name);
          try {
            // The shared descriptor layer caps a listing at 10,000 names. Overflow throws;
            // never label an unreadable or over-budget directory as an empty complete tree.
            const names = descriptorNames(
              directory.fd,
              Math.min(10_000, this.budget.remaining + 1),
            );
            for (const entry of names) {
              if (!this.going() || this.budget.remaining <= 0) {
                size.complete = false;
                break;
              }
              await visit(directory, entry, `${display}/${entry}`, depth + 1);
            }
          } finally {
            directory.closeSync();
          }
        } else if ((info.mode & 0o170000) === 0o100000 || (info.mode & 0o170000) === 0o120000) {
          const key = `${info.dev}:${info.ino}`;
          // MIME aliases in the attachment blob root are hard links to the same bytes.
          if (seen && (info.mode & 0o170000) === 0o100000) {
            if (seen.has(key)) return;
            seen.add(key);
          }
          size.bytes += info.size;
          size.items++;
        } else size.complete = false;
      } catch {
        size.complete = false;
      }
    };
    const parts = path.split("/");
    const name = parts.pop();
    if (!name) return { ...size, complete: false };
    const opened: PinnedDirectory[] = [];
    let parent = root;
    try {
      for (const part of parts) {
        if (!(await this.step())) return { ...size, complete: false };
        parent = parent.child(part);
        opened.push(parent);
      }
      // A category root that never existed is empty. Disappearance within a tree is partial.
      try {
        parent.metadata(name);
      } catch (error) {
        if (missingUsagePath(error)) return size;
        throw error;
      }
      await visit(parent, name, path, 0);
    } catch (error) {
      if (!missingUsagePath(error)) size.complete = false;
    } finally {
      for (const directory of opened.toReversed()) directory.closeSync();
    }
    return size;
  }
}
