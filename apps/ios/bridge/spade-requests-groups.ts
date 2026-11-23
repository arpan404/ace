import {
  parseSpadeGroup,
  parseSpadeGroupFiles,
  parseSpadeGroups,
  SpadeRequestError,
  spadeGroupMembersMax,
  spadeGroupMembersMin,
  spadeGroupNameMax,
  type SpadeGroup,
  type SpadeGroupFile,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { utf8Bytes } from "./spade-profile.ts";
import type { NativeSpade } from "./spade.ts";
import { segment } from "./spade-text.ts";
import { spadeGroupProfileRow } from "./spade-group-rows.ts";
import { spadeRefused, spadeRequestArea, type SpadeOutcome } from "./spade-requests-area.ts";

/*
 * A group (ADR 0132, spade/docs/teams.md): make one, read its profile, rename it and change its
 * members and lead, read its Library, delete it, pin it, post to it and stop its run.
 */

const groupId = z.string().min(1).max(256);
const agentId = z.string().min(1).max(256);
const name = z.string().trim().min(1).max(spadeGroupNameMax);

/** A member as Spade takes it: `machine` is its bot's host id, absent for the group's own. */
const member = z.object({ agent: agentId, machine: z.string().min(1).max(256).optional() });
const members = z.array(member).min(1).max(spadeGroupMembersMax);

/** A message the person posts to a group: it starts a run its lead answers. */
const SpadeGroupSendRequest = z.object({
  type: z.literal("spade.group.send"),
  groupId,
  conversationId: z.string().min(1).max(256),
  text: z.string().trim().min(1).max(200_000),
});

/** What a Library answer may weigh in UTF-8, leaving the rest of a 32 KiB frame for its envelope. */
const filesBudget = 28_000;

export const spadeGroupRequests = spadeRequestArea(
  [
    SpadeGroupSendRequest,
    /** Stop ends the group's run: every ask still open, on every machine. */
    z.object({ type: z.literal("spade.group.stop"), groupId }),
    /** Pin the group to the strip above the list, or unpin it, on every device. */
    z.object({ type: z.literal("spade.group.pin"), groupId, pinned: z.boolean() }),
    /** A new group, made on its lead's machine: the members are named against it. */
    z.object({ type: z.literal("spade.group.create"), name, members, lead: agentId }),
    /** A group's profile, read afresh: its name, lead and members with their faces. */
    z.object({ type: z.literal("spade.group.read"), groupId }),
    /** Only what changed: a new name, one member edit, or another lead. */
    z.strictObject({
      type: z.literal("spade.group.edit"),
      groupId,
      name: name.optional(),
      memberEdit: z.object({ action: z.enum(["add", "remove"]), member }).optional(),
      lead: agentId.optional(),
    }),
    /** Deletes the group and its conversation; its bots stay. */
    z.object({ type: z.literal("spade.group.delete"), groupId }),
    /** The files its members made answering it, newest first: its Library. */
    z.object({ type: z.literal("spade.group.files"), groupId }),
  ],
  async ({ spade, deps, ask }, request) => {
    switch (request.type) {
      case "spade.group.send":
        return sendToGroup(spade, request, deps, () =>
          ask("POST", `${groupPath(request.groupId)}/messages`, { text: request.text }),
        );
      case "spade.group.stop":
        try {
          await ask("POST", `${groupPath(request.groupId)}/stop`);
        } catch (error) {
          // 404: nothing was running by the time Stop arrived, which is what Stop wanted.
          if (!(error instanceof SpadeRequestError && error.status === 404))
            return spadeRefused("Couldn't stop", error);
        }
        spade.refresh();
        return { ok: true };
      case "spade.group.pin":
        return changed(spade, request.pinned ? "Couldn't pin" : "Couldn't unpin", () =>
          ask("PUT", `${groupPath(request.groupId)}/pin`, { pinned: request.pinned }),
        );
      case "spade.group.create":
        try {
          const { type: _, ...draft } = request;
          const group = parseSpadeGroup(await ask("POST", "/v1/groups", draft));
          if (!group) throw new Error("Spade's new club didn't make sense.");
          spade.refresh();
          return { ok: true, made: { group: group.id, conversation: group.conversation } };
        } catch (error) {
          return spadeRefused("Couldn't make the club", error);
        }
      case "spade.group.read":
        try {
          const group = await readGroup(request.groupId, () => ask("GET", "/v1/groups"));
          const agents = group.members.flatMap((member) => spade.bot(member.agent) ?? []);
          return { ok: true, group: spadeGroupProfileRow(group, agents, spade.host) };
        } catch (error) {
          return spadeRefused("Couldn't read the club", error);
        }
      case "spade.group.edit": {
        const { type: _, groupId: id, memberEdit, ...change } = request;
        const said = spade.groupName(id);
        const title = said ? `Couldn't change ${said}` : "Couldn't change the club";
        const pending = groupEdits.get(spade) ?? new Set<string>();
        if (pending.has(id)) return { ok: false, title, message: "A club edit is already saving." };
        pending.add(id);
        groupEdits.set(spade, pending);
        try {
          return await changed(spade, title, async () => {
            if (!memberEdit) return ask("PATCH", groupPath(id), change);
            const group = await readGroup(id, () => ask("GET", "/v1/groups"));
            const roster = group.members.map(({ agent, machine }) =>
              machine === null ? { agent } : { agent, machine },
            );
            const matches = (ref: z.infer<typeof member>) =>
              ref.agent === memberEdit.member.agent && ref.machine === memberEdit.member.machine;
            if (memberEdit.action === "add" && !roster.some(matches))
              roster.push(memberEdit.member);
            const next =
              memberEdit.action === "remove" ? roster.filter((ref) => !matches(ref)) : roster;
            return ask("PATCH", groupPath(id), { ...change, members: next });
          });
        } finally {
          pending.delete(id);
        }
      }
      case "spade.group.delete": {
        const said = spade.groupName(request.groupId);
        return changed(spade, said ? `Couldn't delete ${said}` : "Couldn't delete the club", () =>
          ask("DELETE", groupPath(request.groupId)),
        );
      }
      case "spade.group.files":
        try {
          const read = (route: string) => ask("GET", route);
          const [files, group] = await Promise.all([
            parseSpadeGroupFiles(await read(`${groupPath(request.groupId)}/files`)),
            readGroup(request.groupId, () => read("/v1/groups")).catch(() => undefined),
          ]);
          if (!files) throw new Error("Spade's club files didn't make sense.");
          return { ok: true, ...fileRows(files, group, spade) };
        } catch (error) {
          return spadeRefused("Couldn't read the club's files", error);
        }
    }
  },
);

const groupEdits = new WeakMap<NativeSpade, Set<string>>();

const groupPath = (id: string) => `/v1/groups/${segment(id)}`;

/** A change to Spade's groups; the list is read again once it went, so the rows follow. */
async function changed(
  spade: NativeSpade,
  title: string,
  send: () => Promise<string>,
): Promise<SpadeOutcome> {
  try {
    await send();
    spade.refresh();
    return { ok: true };
  } catch (error) {
    return spadeRefused(title, error);
  }
}

/** The group as Spade lists it now; one it no longer has is refused in words. */
async function readGroup(id: string, read: () => Promise<string>): Promise<SpadeGroup> {
  const groups = parseSpadeGroups(await read());
  if (!groups) throw new Error("Spade's clubs didn't make sense.");
  const group = groups.find((each) => each.id === id);
  if (!group) throw new Error("This club isn't in Spade any more.");
  return group;
}

/**
 * The Library's rows, newest first as Spade sends them, each naming the member that made it: the
 * roster's name, else the group's, else (a member that left) its id. Rows past what one answer
 * may weigh are counted in `more`.
 */
function fileRows(
  files: readonly SpadeGroupFile[],
  group: SpadeGroup | undefined,
  spade: NativeSpade,
) {
  const by = (agent: string) =>
    spade.bot(agent)?.name ||
    group?.members.find((member) => member.agent === agent)?.name ||
    agent;
  const rows = files.map((file) => ({
    agent: file.agent,
    by: by(file.agent),
    name: file.path.split("/").at(-1) || file.path,
    path: file.path,
    at: file.at,
  }));
  let more = 0;
  while (rows.length && utf8Bytes(JSON.stringify(rows)) > filesBudget) {
    rows.pop();
    more++;
  }
  return { files: rows, more };
}

/**
 * A post to a group shows at once, as a bot's message does; one Spade never stored is refused,
 * so its words go back to the composer.
 */
async function sendToGroup(
  spade: NativeSpade,
  request: z.infer<typeof SpadeGroupSendRequest>,
  deps: { id(): string },
  post: () => Promise<string>,
): Promise<SpadeOutcome> {
  const follow = spade.groupFollow(request.conversationId);
  const key = `local-${deps.id()}`;
  follow?.apply({ kind: "sent", key, text: request.text, images: [], documents: [] });
  try {
    await post();
    spade.refresh();
    return { ok: true };
  } catch (error) {
    if (
      follow &&
      error instanceof SpadeRequestError &&
      error.unanswered &&
      (await follow.reached(key))
    ) {
      spade.refresh();
      return { ok: true };
    }
    follow?.apply({ kind: "refused", key });
    const said = spade.groupName(request.groupId);
    return spadeRefused(said ? `Couldn't send to ${said}` : "Couldn't send", error);
  }
}
