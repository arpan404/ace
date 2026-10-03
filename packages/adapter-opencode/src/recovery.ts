import { z } from "zod";
import type { OpenCodeClient } from "@opencode/client";
import { SessionInfo, PendingList, Page, ProjectedMessage } from "./boundaries.ts";
import { object, string, number } from "./data.ts";
import type { HistoryReader } from "./history.ts";
import type { SessionOwnership } from "./ownership.ts";
import type { Observe } from "./observation.ts";
export type RecoveryPorts = {
  client: OpenCodeClient;
  ownership: SessionOwnership;
  history: HistoryReader;
  watermark(): number;
  frame: Observe;
  receive(event: unknown): void;
  stage(channel: string, data: unknown, session: string, started: number): void;
  liveMessages(id: string): string[];
  executionObserved: ReadonlySet<string>;
  shell(id: string, directory: string): Promise<unknown>;
};
/** Read only proven owners. No unscoped global lists or log-retention assumptions. */
export async function recoverSessions(p: RecoveryPorts): Promise<void> {
  const visited = new Set<string>();
  const visit = async (id: string, depth: number): Promise<void> => {
    if (visited.has(id) || depth > 64) throw new Error("OpenCode ancestry cycle/depth exceeded");
    visited.add(id);
    const info = SessionInfo.parse(await p.client.session.get({ sessionID: id }));
    p.ownership.verify(info);
    p.frame("recv", "snapshot.info", { info });
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 64; page++) {
      const children = Page.parse(
        await p.client.session.list({
          parentID: id,
          directory: info.location.directory,
          project: info.projectID,
          order: "asc",
          limit: 128,
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const value of children.data) {
        const child = SessionInfo.parse(value);
        p.ownership.admit(child, id);
        await visit(child.id, depth + 1);
      }
      if (!children.cursor.next) break;
      if (cursors.has(children.cursor.next) || page === 63)
        throw new Error("OpenCode child pagination incomplete");
      cursors.add(children.cursor.next);
      cursor = children.cursor.next;
    }
    for (const [known, owner] of p.ownership.sessions)
      if (owner.parent === id && !visited.has(known)) await visit(known, depth + 1);
    for (const messageID of p.liveMessages(id)) {
      const message = ProjectedMessage.parse(
        await p.client.session.message.get({ sessionID: id, messageID }),
      );
      p.frame("recv", "snapshot.message", { sessionID: id, message });
    }
    await p.history.read(
      id,
      (messageCursor) =>
        p.client.message.list({
          sessionID: id,
          limit: 128,
          order: "desc",
          ...(messageCursor ? { cursor: messageCursor } : {}),
        }),
      (message) => p.frame("recv", "snapshot.message", { sessionID: id, message }),
    );
    const started = p.watermark();
    const permissions = PendingList.parse(await p.client.permission.list({ sessionID: id }));
    const forms = PendingList.parse(await p.client.session.form.list({ sessionID: id }));
    const inbox = PendingList.parse(await p.client.session.inbox.list({ sessionID: id }));
    if (inbox.some((entry) => entry.sessionID !== id))
      throw new Error("OpenCode inbox ownership mismatch");
    const keys: string[] = [];
    for (const [type, values] of [
      ["permission.asked", permissions],
      ["form.created", forms],
    ] as const)
      for (const value of values) {
        if (value.sessionID !== id) throw new Error("OpenCode interaction ownership mismatch");
        const key = `${type === "permission.asked" ? "permission" : "form"}:${id}:${string(value.id)}`;
        keys.push(key);
        p.receive({
          id: `snapshot:${key}`,
          type,
          data: type === "form.created" ? { form: value } : value,
        });
      }
    p.stage("snapshot.interactions", { sessionID: id, keys }, id, started);
    p.stage("snapshot.inbox", { sessionID: id, items: inbox }, id, started);
  };
  await visit(p.ownership.root, 0);
  // Active is global metadata, not a discovery list. It is read once per pass,
  // and only keys whose ancestry was established above are considered.
  const started = p.watermark(),
    active = z.record(z.string(), z.unknown()).parse(await p.client.session.active());
  for (const id of visited) {
    const info = SessionInfo.parse(await p.client.session.get({ sessionID: id }));
    p.ownership.verify(info);
    const running = object(active[id]).type === "running";
    if (
      !running &&
      p.executionObserved.has(id) &&
      typeof object(info.time).idle !== "number" &&
      !info.outcome
    )
      throw new Error("OpenCode execution settlement is unknown");
    p.stage(
      "snapshot.active",
      {
        sessionID: id,
        running,
        outcome: info.outcome,
        idleAt: object(info.time).idle,
        revision: `${number(object(info.time).updated)}:${started}`,
      },
      id,
      started,
    );
  }
  const observedShells = new Set<string>();
  for (const directory of new Set([...p.ownership.sessions.values()].map((s) => s.directory))) {
    const listing = z
      .object({ location: z.object({ directory: z.literal(directory) }), data: PendingList })
      .parse(await p.client.shell.list({ location: { directory } }));
    for (const info of listing.data) {
      const owner = string(object(info.metadata).sessionID);
      if (p.ownership.sessions.get(owner)?.directory !== directory) continue;
      observedShells.add(string(info.id));
      p.receive({
        id: `snapshot:shell:${string(info.id)}:${string(info.status)}`,
        type: "shell.created",
        location: { directory },
        data: { info },
      });
    }
  }
  for (const [id, owner] of p.ownership.shells) {
    if (observedShells.has(id)) continue;
    const directory = p.ownership.sessions.get(owner)?.directory;
    if (!directory) throw new Error("OpenCode shell owner missing");
    const value = await p.shell(id, directory);
    if (value === undefined)
      p.receive({
        id: `snapshot:shell:${id}:deleted`,
        type: "shell.deleted",
        location: { directory },
        data: { id },
      });
    else {
      const info = z
        .object({
          id: z.literal(id),
          status: z.string(),
          metadata: z.object({ sessionID: z.literal(owner) }).passthrough(),
        })
        .passthrough()
        .parse(object(value).data);
      p.receive({
        id: `snapshot:shell:${id}:${info.status}`,
        type: "shell.created",
        location: { directory },
        data: { info },
      });
    }
  }
}
