import { SessionInfo, NativeEvent, eventSession } from "./boundaries.ts";
import { object, string } from "./data.ts";
import type { z } from "zod";
type Info = z.infer<typeof SessionInfo>;
/** Session IDs alone are never evidence of ancestry or location ownership. */
export class SessionOwnership {
  root: string;
  readonly directory: string;
  sessions = new Map<string, { parent: string; directory: string; project: string }>();
  shells = new Map<string, string>();
  private children = new Map<string, Set<string>>();
  constructor(directory: string, root: string) {
    this.directory = directory;
    this.root = root;
  }
  establish(value: unknown): void {
    const info = SessionInfo.parse(value);
    if ((this.root && info.id !== this.root) || info.location.directory !== this.directory)
      throw new Error("OpenCode root ownership mismatch");
    this.root = info.id;
    this.sessions.set(info.id, {
      parent: string(info.parentID),
      directory: info.location.directory,
      project: info.projectID,
    });
  }
  verify(info: Info): void {
    const owner = this.sessions.get(info.id);
    if (!owner || string(info.parentID) !== owner.parent || (info.id !== this.root && info.fork))
      throw new Error("Inconsistent OpenCode ancestry");
    // A GET for an already-owned ID confirms its new stored location/project.
    this.sessions.set(info.id, {
      ...owner,
      directory: info.location.directory,
      project: info.projectID,
    });
  }
  admit(info: Info, parent: string): void {
    const owner = this.sessions.get(parent);
    if (
      !owner ||
      info.parentID !== parent ||
      info.fork ||
      info.id === this.root ||
      info.location.directory !== owner.directory ||
      info.projectID !== owner.project ||
      (this.sessions.has(info.id) && this.sessions.get(info.id)?.parent !== parent)
    )
      throw new Error("OpenCode child ownership mismatch");
    if (this.sessions.size >= 1024 && !this.sessions.has(info.id))
      throw new Error("OpenCode tree limit");
    this.sessions.set(info.id, {
      parent,
      directory: info.location.directory,
      project: info.projectID,
    });
    const children = this.children.get(parent) ?? new Set<string>();
    children.add(info.id);
    this.children.set(parent, children);
  }
  accept(value: unknown): boolean {
    const parsed = NativeEvent.safeParse(value);
    if (!parsed.success) return false;
    const e = parsed.data,
      p = e.data;
    if (e.type === "session.created") {
      const candidate = SessionInfo.safeParse({ ...p, id: p.sessionID });
      if (!candidate.success) return false;
      if (candidate.data.id === this.root)
        return candidate.data.location.directory === this.sessions.get(this.root)?.directory;
      try {
        this.admit(candidate.data, string(p.parentID));
      } catch {
        return false;
      }
    }
    const id = eventSession(e),
      owner = this.sessions.get(id);
    if (e.type === "shell.exited" || e.type === "shell.deleted") {
      const session = this.shells.get(string(p.id));
      return (
        !!session && (!e.location || e.location.directory === this.sessions.get(session)?.directory)
      );
    }
    if (!owner) return false;
    if (e.type === "session.moved") return true;
    if (e.location && e.location.directory !== owner.directory) return false;
    if (typeof p.projectID === "string" && p.projectID !== owner.project) return false;
    if (e.type === "shell.created") {
      const info = object(p.info),
        shell = string(info.id);
      if (!shell) return false;
      if (this.shells.size >= 2048 && !this.shells.has(shell))
        throw new Error("OpenCode shell limit");
      this.shells.set(shell, id);
    }
    if (e.type === "session.tool.progress" || e.type === "session.tool.success") {
      const shell = string(object(p.metadata).shellID);
      if (shell) {
        if (this.shells.size >= 2048 && !this.shells.has(shell))
          throw new Error("OpenCode shell limit");
        this.shells.set(shell, id);
      }
    }
    return true;
  }
  descendants(root: string): string[] {
    const result: string[] = [],
      visited = new Set<string>([root]);
    const visit = (id: string) => {
      for (const child of this.children.get(id) ?? []) {
        if (visited.has(child)) throw new Error("OpenCode ancestry cycle");
        visited.add(child);
        visit(child);
        result.push(child);
      }
    };
    visit(root);
    return result;
  }
}
