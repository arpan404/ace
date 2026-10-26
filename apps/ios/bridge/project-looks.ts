import type { ClientCore } from "@ace/client";
import type { Project } from "@ace/protocol";
import { projectGlyphIcons, projectMark, type ProjectLook } from "@ace/ui-core";
import type { PatchSink } from "./agents.ts";
import { readProjects } from "./project-list.ts";

/*
 * Each project's mark for the inbox rows, sent once per project and again only when it changes.
 * Rows change often and projects rarely, so a row names its project by `workspaceId` and never
 * carries image data. A project with no image and no chosen glyph sends nothing: its rows draw
 * the initials they already carry (`badge`). Chats (ADR 0099) send nothing either; their rows
 * say they are chats.
 */

/** What Swift draws for a project's mark: an image to try first, then a glyph by icon name. */
export interface ProjectLookRow {
  image: string | null;
  glyph: string | null;
}

/** The shared mark rule (`projectMark`) as Swift reads it; null when the initials are enough. */
export function projectLookRow(look: ProjectLook | undefined): ProjectLookRow | null {
  const mark = projectMark(look);
  const glyph = mark.glyph ? projectGlyphIcons[mark.glyph] : null;
  return mark.image || glyph ? { image: mark.image ?? null, glyph } : null;
}

export type ProjectLooksOwner = Pick<ClientCore, "request" | "connectionState" | "onMessage">;

const quiet = { timeoutMs: 15_000 };
/** Rows only need the projects that have threads; a machine rarely has more. */
const maxProjects = 1_000;

/**
 * Reads the machine's projects on every ready connection and follows `workspace.changed`, putting
 * `project:<id>` only for a project whose look differs from the one last sent.
 */
export function followProjectLooks(owner: ProjectLooksOwner, pump: PatchSink): () => void {
  /** The look last sent per project, as JSON, so an unchanged one is never sent again. */
  const sent = new Map<string, string>();
  let stopped = false;
  let reading = false;
  let again = false;
  const put = (id: string, look: ProjectLookRow | null) => {
    const key = look ? JSON.stringify(look) : undefined;
    if (sent.get(id) === key) return;
    if (key === undefined) sent.delete(id);
    else sent.set(id, key);
    pump.put(`project:${id}`, () => ({ type: "project.look", id, look }));
  };
  const show = (project: Project) =>
    put(project.id, project.kind === "chat" ? null : projectLookRow(project));
  const connection = owner.connectionState();
  const read = async () => {
    if (connection.getSnapshot() !== "ready" || stopped) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      const projects = await readProjects(owner, quiet, maxProjects);
      if (stopped) return;
      const listed = new Set(projects.map((project) => project.id));
      for (const id of [...sent.keys()]) if (!listed.has(id)) put(id, null);
      for (const project of projects) show(project);
    } catch {
      // A machine that can't list its projects keeps the marks the phone last drew.
    } finally {
      reading = false;
      if (again && !stopped) {
        again = false;
        void read();
      }
    }
  };
  const stopConnection = connection.subscribe(() => void read());
  const stopMessages = owner.onMessage((message) => {
    if (message.type !== "workspace.changed") return;
    if (message.change === "removed") put(message.workspaceId, null);
    else if (message.workspace) show(message.workspace);
    else void read();
  });
  void read();
  return () => {
    stopped = true;
    stopConnection();
    stopMessages();
  };
}
