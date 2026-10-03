import type { Fact, Key } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import { InteractionResolution } from "@ace/protocol";
import type { Frame, Translator } from "@ace/engine-api";
import { NativeEvent, eventSession } from "./boundaries.ts";
import { object, array, string, number, retryReason } from "./data.ts";
import { NativeState } from "./native-state.ts";
import { tool, text, projected } from "./native-content.ts";
import { interaction } from "./interactions.ts";
export class OpenCodeTranslator implements Translator {
  private state: NativeState;
  constructor(init: { threadId: ThreadId; rootKey: Key }) {
    this.state = new NativeState(init.rootKey);
  }
  translate(frame: Frame, now: number): Fact[] {
    try {
      return this.frame(frame, now);
    } catch {
      this.state.disconnected = true;
      return [
        { type: "agent.disconnected", agent: this.state.rootKey },
        ...this.state.note(frame.data, "Malformed or over-limit OpenCode frame"),
      ];
    }
  }
  private frame(frame: Frame, now: number): Fact[] {
    const data = object(frame.data),
      state = this.state;
    if (frame.channel === "clock") return [];
    if (frame.channel === "interaction.resolving" || frame.channel === "interaction.rejected") {
      const pending = state.pending.get(string(data.key));
      if (pending) {
        if (frame.channel === "interaction.resolving")
          pending.resolution = InteractionResolution.parse(data.resolution);
        else delete pending.resolution;
      }
      return [];
    }
    if (frame.channel === "transport.activity") return [{ type: "signal" }];
    if (frame.channel === "lifecycle") {
      if (data.type === "started") return [{ type: "process.started" }];
      if (data.type === "exited") {
        state.pending.clear();
        return [
          {
            type: "process.exited",
            deliberate: data.deliberate === true,
            message: string(data.message),
          },
        ];
      }
      if (data.type === "disconnected" || data.type === "resynced") {
        state.disconnected = data.type === "disconnected";
        return [...state.agents.keys()]
          .filter(
            (id) =>
              state.disconnected || !state.lostLocations.has(state.agents.get(id)?.directory ?? ""),
          )
          .map((id) => ({
            type: state.disconnected ? "agent.disconnected" : "agent.reconnected",
            agent: state.key(id),
          }));
      }
      return [];
    }
    if (frame.channel === "input.sending") {
      const id = string(data.id);
      if (state.commands.size >= 1024 && !state.commands.has(id))
        throw new Error("OpenCode command correlation limit");
      const command = string(data.commandId);
      if (command) state.commands.set(id, command);
      return [];
    }
    if (frame.channel === "input.uncertain") {
      const id = string(data.id),
        session = state.inputs.get(id);
      return session && !state.admitted.has(id)
        ? state.background(`admission:${id}`, session, "other")
        : [];
    }
    if (frame.channel === "input.rejected") {
      state.inputs.delete(string(data.id));
      state.commands.delete(string(data.id));
      state.admissionPending.delete(string(data.id));
      return [
        ...state.finishBackground(`admission:${string(data.id)}`, "stopped"),
        ...state.queue(),
      ];
    }
    if (frame.channel === "http") {
      const path = string(data.path).split("?")[0] ?? "",
        body = object(data.body);
      if (frame.dir === "recv" && data.method === "POST" && path === "/api/session")
        return state.seen(object(body.data));
      const prompt = /^\/api\/session\/([^/]+)\/prompt$/.exec(path);
      if (prompt && frame.dir === "send") {
        state.triggers.set(string(prompt[1]), "user");
        state.admissionPending.add(string(body.id));
        return [
          ...state.input(string(body.id), string(prompt[1])),
          ...projected(state, string(prompt[1]), { id: body.id, type: "user", text: body.text }),
        ];
      }
      if (prompt && frame.dir === "recv" && data.status === 200) {
        const admitted = object(body.data),
          id = string(admitted.id),
          session = string(prompt[1]);
        if (
          admitted.sessionID === session &&
          state.inputs.get(id) === session &&
          !state.admitted.has(id)
        ) {
          return [...state.admit(id, session), ...state.queue()];
        }
      }
      // Admission/interrupt receipts never settle a turn.
      return [];
    }
    if (frame.channel === "snapshot.message") {
      const message = object(data.message),
        id = string(message.id);
      const delivered = message.type === "user" || message.type === "synthetic";
      const admitted: Fact[] = [];
      if (delivered && state.admissionPending.has(id) && !state.admitted.has(id)) {
        admitted.push(...state.admit(id, string(data.sessionID)));
      }
      if (delivered) {
        state.inputs.delete(id);
        state.commands.delete(id);
        state.admissionPending.delete(id);
      }
      return [
        ...admitted,
        ...projected(state, string(data.sessionID), data.message),
        ...(delivered
          ? [...state.finishBackground(`admission:${id}`, "completed"), ...state.queue()]
          : []),
      ];
    }
    if (frame.channel === "snapshot.info") {
      if (data.root === true && !state.rootNative) state.rootNative = string(object(data.info).id);
      return [
        ...state.seen(object(data.info)),
        ...(data.recovering === true ? [] : state.reconcileOutcome(object(data.info))),
      ];
    }
    if (frame.channel === "snapshot.active") {
      const id = string(data.sessionID);
      if (data.running !== true && !state.canSettle(id, number(data.idleAt, -1))) return [];
      return data.running === true
        ? state.start(id, `recovered:${id}:${string(data.revision)}`)
        : [
            ...state.reconcileWake(id, number(data.idleAt, -1)),
            ...state.end(
              id,
              data.outcome === "interrupted"
                ? "interrupted"
                : data.outcome === "failed"
                  ? "failed"
                  : "completed",
            ),
          ];
    }
    if (frame.channel === "snapshot.interactions") {
      const session = string(data.sessionID),
        keys = new Set(array(data.keys).map((v) => string(v))),
        facts: Fact[] = [];
      for (const [key, pending] of state.pending)
        if (pending.session === session && !keys.has(key)) {
          state.pending.delete(key);
          facts.push({ type: "interaction.closed", interaction: key, state: "expired" });
        }
      return facts;
    }
    if (frame.channel === "snapshot.inbox") {
      const session = string(data.sessionID),
        entries = array(data.items).map(object),
        ids = new Set(entries.map((p) => string(p.id)));
      // Absence alone cannot distinguish rejection from an accepted input whose
      // inbox entry was consumed before history caught up. Retain uncertainty
      // until delivery/history/cancellation or a definite admission rejection.
      const facts: Fact[] = [];
      for (const id of ids) {
        if (state.admissionPending.has(id) && !state.admitted.has(id)) {
          facts.push(...state.admit(id, session));
        }
        state.admissionPending.delete(id);
        state.input(id, session);
      }
      return [...facts, ...state.queue()];
    }
    if (frame.channel !== "sse") return [];
    const e = NativeEvent.parse(frame.data),
      p = e.data,
      type = e.type;
    if (e.durable) {
      const before = state.durable.get(e.durable.aggregateID);
      if (before !== undefined && e.durable.seq <= before) return [];
      state.durable.set(e.durable.aggregateID, e.durable.seq);
    }
    if (state.events.has(e.id)) return [];
    state.events.add(e.id);
    if (type === "location.shutdown" && e.location) {
      const directory = e.location.directory;
      state.lostLocations.add(directory);
      const facts: Fact[] = [];
      for (const [key, pending] of state.pending)
        if (state.agents.get(pending.session)?.directory === directory) {
          state.pending.delete(key);
          facts.push({ type: "interaction.closed", interaction: key, state: "expired" });
        }
      for (const [id, owner] of state.agents)
        if (owner.directory === directory)
          facts.push({ type: "agent.disconnected", agent: state.key(id) });
      return facts;
    }
    if (type === "session.created") return state.seen(p);
    if (type === "shell.created") {
      const info = object(p.info),
        id = string(info.id),
        session = string(object(info.metadata).sessionID);
      if (!state.agents.has(session)) return [];
      if (info.status !== "running") {
        state.shells.delete(id);
        const wake = state.wakeShells.delete(id);
        return [
          ...state.finishBackground(
            `shell:${id}`,
            info.status === "killed" ? "stopped" : info.exit === 0 ? "completed" : "failed",
          ),
          ...(wake
            ? state.wake(session, number(object(info.time).completed, Number.MAX_SAFE_INTEGER))
            : []),
        ];
      }
      if (state.shells.size >= 2048 && !state.shells.has(id))
        throw new Error("OpenCode shell limit");
      state.shells.set(id, session);
      return state.background(`shell:${id}`, session, "shell");
    }
    if (type === "shell.exited" || type === "shell.deleted") {
      const id = string(p.id),
        session = state.shells.get(id);
      if (!session) return [];
      state.shells.delete(id);
      const wake = state.wakeShells.delete(id);
      return [
        ...state.finishBackground(
          `shell:${id}`,
          type === "shell.deleted" || p.status === "killed"
            ? "stopped"
            : p.exit === 0
              ? "completed"
              : "failed",
        ),
        ...(wake ? state.wake(session) : []),
      ];
    }
    const id = eventSession(e);
    if (!state.agents.has(id)) return [];
    const agent = state.key(id);
    if (type === "session.execution.started") {
      const facts = state.start(id, `execution:${id}:${e.durable?.seq ?? e.id}`);
      if (facts.length && typeof e.created === "number") state.executionCreated.set(id, e.created);
      return facts;
    }
    if (
      type === "session.execution.succeeded" ||
      type === "session.execution.failed" ||
      type === "session.execution.interrupted"
    )
      return state.end(
        id,
        type.endsWith("succeeded")
          ? "completed"
          : type.endsWith("failed")
            ? "failed"
            : "interrupted",
        p.error,
      );
    if (type.startsWith("session.text.") || type.startsWith("session.reasoning."))
      return text(state, type, p, e);
    if (type.startsWith("session.tool."))
      return type.endsWith("delta") ? [] : tool(state, p, type, e);
    if (type.startsWith("permission.") || type.startsWith("form."))
      return interaction(state, type, p, e);
    if (type === "session.inbox.enqueued") {
      const input = string(p.inboxID),
        own = state.admissionPending.delete(input);
      const facts = state.input(input, id);
      if (own && !state.admitted.has(input)) {
        facts.unshift(...state.admit(input, id));
      }
      return facts;
    }
    if (type === "session.inbox.delivered" || type === "session.inbox.cancelled") {
      const admitted = state.admissionPending.has(string(p.inboxID))
        ? state.admit(string(p.inboxID), id)
        : [];
      state.inputs.delete(string(p.inboxID));
      state.commands.delete(string(p.inboxID));
      state.admissionPending.delete(string(p.inboxID));
      return [
        ...admitted,
        ...state.finishBackground(`admission:${string(p.inboxID)}`, "completed"),
        ...state.queue(),
        ...(type.endsWith("delivered") && !state.active.has(id) ? state.wake(id) : []),
      ];
    }
    if (type === "session.synthetic") {
      const meta = object(p.metadata);
      state.triggers.set(
        id,
        meta.source === "subagent" ? "subagent_result" : "background_completion",
      );
      return [
        ...state.completion(meta, number(e.created, -1)),
        ...state.wake(id, number(e.created, Number.MAX_SAFE_INTEGER)),
      ];
    }
    if (type === "session.retry.scheduled")
      return [
        {
          type: "retry",
          agent,
          on: retryReason(string(object(p.error).message)),
          attempt: number(p.attempt),
          until: now + Math.max(0, number(p.at) - number(e.created)),
          message: string(object(p.error).message),
        },
      ];
    if (type === "session.usage.updated") {
      const tokens = object(p.tokens);
      if (!Object.keys(tokens).length) return [];
      return [
        {
          type: "usage",
          agent,
          inputTokens:
            number(tokens.input) +
            number(object(tokens.cache).read) +
            number(object(tokens.cache).write),
          outputTokens: number(tokens.output) + number(tokens.reasoning),
          cachedInputTokens: number(object(tokens.cache).read),
          reasoningTokens: number(tokens.reasoning),
          cacheWriteTokens: number(object(tokens.cache).write),
          counterMode: "cumulative",
          counterKey: `session:${id}`,
          costUsd: number(p.cost),
        },
      ];
    }
    if (type.startsWith("session.step.")) return [];
    return state.note(e, type);
  }
  isSettled(): boolean {
    return this.state.settled();
  }
  liveMessages(session: string): string[] {
    return [...(this.state.liveMessages.get(session)?.keys() ?? [])];
  }
  taskOwner(task: string): string | undefined {
    return this.state.backgrounds.get(task);
  }
  tick(_now: number): Fact[] {
    return [];
  }
}
