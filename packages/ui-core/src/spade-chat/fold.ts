import type { SpadeKnownEvent, SpadeStored } from "./wire.ts";
import { spadeHelperTask, spadeHelperTool } from "./helper-words.ts";
import { spadeContractAsk } from "./contract-words.ts";
import {
  spadeBotMessageTool,
  spadeContractAsked,
  spadeContractCalled,
  spadeContractFinished,
  spadeContractEnded,
  spadeTalkFinished,
  spadeTalkStarted,
} from "./bot-talk.ts";
import { spadeCardQuestions, spadeConnectOf } from "./questions.ts";
import { emptySpadeCapabilities, foldSpadeCapability } from "./fold-capabilities.ts";
import { spadeJoinWorkers } from "./delegations.ts";
import { parseSpadeDecision } from "./decisions.ts";
import { spadeCardChosen, spadeCardShown } from "./cards.ts";
import { spadeNoticeSent } from "./notices.ts";
import { spadeRiskWeight, spadeStepFacts, spadeStepLine } from "./step-facts.ts";
import { spadeMessageId } from "./chat-markup.ts";
import { spadeSameMessage as sameMessage } from "./pending-match.ts";
import { delegatedTasks } from "./fold-delegated.ts";

import type {
  SpadeQuestionCard,
  SpadeRequest,
  SpadeConversationState,
  SpadeFoldInput,
} from "./fold-types.ts";
import {
  helperEntry,
  recalledOf,
  stamp,
  steer,
  remembered,
  cardAt,
  updateRequest,
  updateQuestion,
  updateOpen,
  replyAt,
  updateReply,
  setCall,
  patchCall,
  refuseCall,
  closeReply,
  closeOpen,
  closeLaneRequests,
} from "./fold-entries.ts";

export * from "./fold-types.ts";

export function emptySpadeConversation(): SpadeConversationState {
  return {
    lastSeq: 0,
    loaded: false,
    caughtUp: false,
    title: "",
    entries: [],
    pending: [],
    open: undefined,
    calls: new Map(),
    running: new Map(),
    approvals: [],
    outsideAsks: [],
    question: undefined,
    forLater: new Set(),
    jobs: new Map(),
    stopping: new Set(),
    unknown: 0,
    decisions: [],
    reviews: new Map(),
    status: undefined,
    reported: undefined,
    waited: 0,
    waitingSince: undefined,
    capabilities: emptySpadeCapabilities(),
    panels: new Map(),
  };
}

/** Apply one input. Returns whether anything the person sees changed. */
export function foldSpade(state: SpadeConversationState, input: SpadeFoldInput): boolean {
  switch (input.kind) {
    case "stored":
      return foldStored(state, input.stored);
    case "snapshot":
      return updateOpen(state, input.reply, (entry) =>
        entry.live === input.text ? undefined : { ...entry, live: input.text },
      );
    case "delta":
      return updateOpen(state, input.reply, (entry) =>
        input.text ? { ...entry, live: entry.live + input.text } : undefined,
      );
    case "sent":
      state.pending = [
        ...state.pending,
        {
          key: input.key,
          text: input.text,
          images: input.images ?? [],
          ...(input.documents?.length ? { documents: input.documents } : {}),
          ...(input.voice ? { voice: input.voice } : {}),
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        },
      ];
      return true;
    case "caught_up": {
      const changed = !state.caughtUp || !state.loaded;
      state.caughtUp = true;
      state.loaded = true;
      return changed;
    }
    case "status": {
      const before = state.reported;
      state.reported = { state: input.state, status: input.status, seq: state.lastSeq };
      const reported =
        before?.state !== input.state ||
        before.status !== input.status ||
        before.seq !== state.lastSeq;
      // Asleep, its words are the resting line's, from its wakes.
      const status =
        input.state === "idle" || input.state === "sleeping" ? undefined : input.status;
      if (state.status === status) return reported;
      state.status = status;
      return true;
    }
    case "refused": {
      const before = state.pending.length;
      state.pending = state.pending.filter((message) => message.key !== input.key);
      return state.pending.length !== before;
    }
  }
}

function foldStored(state: SpadeConversationState, stored: SpadeStored): boolean {
  if (stored.seq <= state.lastSeq) return false;
  state.lastSeq = stored.seq;
  const firstLoad = !state.loaded;
  state.loaded = true;
  const { event } = stored;
  if (event.type === "unknown") {
    const decision = parseSpadeDecision(event.raw, stored.at);
    if (decision) {
      state.decisions = [...state.decisions, decision];
      return true;
    }
    state.unknown++;
    return firstLoad;
  }
  const changed = foldKnown(state, event, stored);
  countWaiting(state, stored.at);
  return changed || firstLoad;
}

/**
 * The open reply's time waiting on the person, as its chat shows the wait (a card or an
 * approval open): counted from the event that began it to the one that ended it, so the working
 * line's clock counts only the bot's own work.
 */
function countWaiting(state: SpadeConversationState, at: number) {
  const waiting =
    state.open !== undefined && (state.question !== undefined || state.approvals.length > 0);
  if (waiting && state.waitingSince === undefined) state.waitingSince = at;
  else if (!waiting && state.waitingSince !== undefined) {
    state.waited += Math.max(0, at - state.waitingSince);
    state.waitingSince = undefined;
  }
}

function foldKnown(state: SpadeConversationState, event: SpadeKnownEvent, stored: SpadeStored) {
  const key = `s${stored.seq}`;
  const capability = foldSpadeCapability(
    state.capabilities,
    event,
    (quiet) => steer(state, { kind: "quiet", key, quiet, ...stamp(stored) }),
    (call, worker) =>
      spadeJoinWorkers(state.entries, call, worker) ||
      steer(state, {
        kind: "workers",
        key,
        call,
        workers: [worker],
        ...(state.open ? { reply: state.open.reply } : {}),
        ...stamp(stored),
      }),
  );
  if (capability !== undefined) return capability;
  switch (event.type) {
    case "user_message": {
      const mine = state.pending.findIndex((message) => sameMessage(message, event));
      const relayed = event.from_agent || event.from_routine || event.from_group;
      if (mine >= 0 && !relayed) state.pending = state.pending.filter((_, index) => index !== mine);
      // The person's message here answers the bot's waiting card; another bot's, or a group's,
      // doesn't. The card says so; `question_answered {typed}` may follow with what it stood for.
      if (!event.from_agent && !event.from_group && state.question) {
        const { callId } = state.question;
        updateQuestion(state, callId, (card) => ({ ...card, standing: "answered", typed: true }));
        state.question = undefined;
      }
      steer(state, {
        kind: "user",
        key,
        // A contract call reads as what it asks, never as raw input (ADR 0200 §7).
        text: event.from_agent?.contract
          ? spadeContractAsk(event.from_agent.contract.contract, event.from_agent.contract.input)
          : event.text,
        images: event.images,
        ...(event.documents.length ? { documents: event.documents } : {}),
        ...(event.voice ? { voice: event.voice } : {}),
        ...(event.from_agent
          ? {
              fromAgent: {
                id: event.from_agent.id,
                name: event.from_agent.name,
                ...(event.from_agent.contract
                  ? { contract: spadeContractAsked(event.from_agent.contract) }
                  : {}),
              },
            }
          : {}),
        ...(event.from_routine ? { fromRoutine: event.from_routine } : {}),
        ...(event.from_group
          ? { fromGroup: { id: event.from_group.id, name: event.from_group.name } }
          : {}),
        ...(event.from_thread
          ? {
              fromThread: {
                id: event.from_thread.id,
                title: event.from_thread.title,
                ...(event.from_thread.machine ? { machine: event.from_thread.machine } : {}),
              },
            }
          : {}),
        ...recalledOf(event.context),
        ...stamp(stored),
        // The person's words and another bot's (not a contract call) are messages the person can
        // reply to (ADR 0212 §4); a routine's or a club's relayed ones aren't.
        ...(event.from_routine || event.from_group || event.from_agent?.contract
          ? {}
          : { id: spadeMessageId(stored.seq) }),
        ...(event.reply_to ? { replyTo: event.reply_to } : {}),
      });
      return true;
    }
    case "reply_started":
      // At most one reply is open; a new one means the last closed without our seeing it.
      if (state.open) closeOpen(state, { kind: "interrupted" }, "");
      state.entries.push({
        kind: "reply",
        key: event.reply,
        reply: event.reply,
        parts: [],
        live: "",
        end: undefined,
        startedAt: stored.at,
      });
      state.open = { reply: event.reply, index: state.entries.length - 1 };
      state.waited = 0;
      state.waitingSince = undefined;
      return true;
    case "reply_progress":
      // A checkpoint is never newer than the live pieces that already extend it.
      return updateOpen(state, event.reply, (entry) =>
        entry.live.startsWith(event.text) ? undefined : { ...entry, live: event.text },
      );
    case "step_served":
      return event.line
        ? updateReply(state, event.reply, (entry) => ({
            ...entry,
            parts: [...entry.parts, { kind: "served" as const, key, line: event.line ?? "" }],
          }))
        : false;
    case "step_finished": {
      const index = replyAt(state, event.reply);
      if (index !== undefined)
        for (const call of event.calls)
          state.calls.set(call.id, { reply: event.reply, index, arguments: call.arguments });
      return updateReply(state, event.reply, (entry) => ({
        ...entry,
        live: "",
        parts: [
          ...entry.parts,
          ...(event.text.trim()
            ? [{ kind: "text" as const, key, text: event.text, seq: stored.seq }]
            : []),
          ...event.calls.map((call) => {
            const { detail, weight } = spadeStepFacts(call.name, call.arguments);
            return {
              kind: "call" as const,
              key: call.id,
              name: call.name,
              state: "queued" as const,
              ...(detail === undefined ? {} : { detail }),
              ...(weight === undefined ? {} : { weight }),
            };
          }),
        ],
      }));
    }
    case "approval_requested": {
      const helper = event.helper ? helperEntry(state, event.helper.job) : undefined;
      state.approvals = [
        ...state.approvals.filter((approval) => approval.callId !== event.call_id),
        {
          reply: event.reply,
          callId: event.call_id,
          name: event.name,
          arguments: event.arguments,
          // An escalation carries the reviewer's reason itself; an older Spade sent it apart.
          reason: event.reviewer_reason || state.reviews.get(event.call_id),
          ...(event.ask ? { ask: event.ask } : {}),
          ...(event.stopped ? { stopped: event.stopped } : {}),
          ...((event.ask === "drive" || event.ask === "app") && event.app
            ? { app: event.app }
            : {}),
          ...(event.effect ? { effect: event.effect } : {}),
          ...(event.tool_key && event.ask !== "undeclared" ? { definition: event.tool_key } : {}),
          ...(event.helper ? { helper: { job: event.helper.job, task: helper?.task ?? "" } } : {}),
          ...(event.lane ? { lane: { task: event.lane.task, title: event.lane.title } } : {}),
        },
      ];
      // Asked again: the request stands where it was first asked. Asked after the person
      // answered (a file it runs changed before it started), it is open again, with why.
      const asked = state.approvals.at(-1);
      if (
        asked &&
        !updateRequest(state, event.call_id, (request) => ({
          ...request,
          reason: asked.reason,
          ...(asked.stopped ? { stopped: asked.stopped } : {}),
          ...(asked.effect ? { effect: asked.effect } : {}),
          ...(asked.definition ? { definition: asked.definition } : {}),
          answer: undefined,
          always: false,
        }))
      ) {
        const request: { kind: "request"; key: string } & SpadeRequest = {
          kind: "request",
          key: `request:${event.call_id}`,
          callId: asked.callId,
          name: asked.name,
          arguments: asked.arguments,
          reason: asked.reason,
          ...(asked.ask ? { ask: asked.ask } : {}),
          ...(asked.stopped ? { stopped: asked.stopped } : {}),
          ...(asked.app ? { app: asked.app } : {}),
          ...(asked.effect ? { effect: asked.effect } : {}),
          ...(asked.definition ? { definition: asked.definition } : {}),
          ...(asked.helper ? { helper: asked.helper } : {}),
          ...(asked.lane ? { lane: asked.lane } : {}),
          answer: undefined,
          always: false,
        };
        // In the reply that asked, after its words so far; a helper's or a lane's where it
        // arrived.
        if (
          event.helper ||
          event.lane ||
          !updateOpen(state, event.reply, (entry) => ({
            ...entry,
            parts: [...entry.parts, request],
          }))
        )
          steer(state, { ...request, ...stamp(stored) });
      }
      // A helper's or a lane's call is its own, not one of the reply's.
      if (!event.helper && !event.lane)
        setCall(state, event.reply, event.call_id, event.name, "waiting");
      return true;
    }
    case "plugin_outside_asked":
      state.outsideAsks = [
        ...state.outsideAsks.filter((ask) => ask.id !== event.id),
        {
          id: event.id,
          plugin: event.plugin,
          version: event.version,
          what: event.what,
          line: event.line,
        },
      ];
      return true;
    case "plugin_outside_answered":
      state.outsideAsks = state.outsideAsks.filter((ask) => ask.id !== event.id);
      return true;
    case "approval_answered":
      state.approvals = state.approvals.filter((approval) => approval.callId !== event.call_id);
      updateRequest(state, event.call_id, (request) => ({
        ...request,
        answer: event.allowed ? "allowed" : "denied",
        always: event.allowed && event.always === true,
      }));
      state.reviews.delete(event.call_id);
      if (!event.allowed) setCall(state, event.reply, event.call_id, undefined, "declined");
      return true;
    case "tool_started": {
      state.running.set(event.call_id, { reply: event.reply, name: event.name });
      setCall(state, event.reply, event.call_id, event.name, "running", stored.seq);
      // Spade's own word on what the call could change outweighs what its arguments read as.
      const weight = spadeRiskWeight(event.name, event.risk);
      if (weight)
        patchCall(state, event.reply, event.call_id, (part) =>
          part.weight === "destructive" || part.weight === weight ? undefined : { ...part, weight },
        );
      const effect = event.effect ?? undefined;
      if (effect)
        patchCall(state, event.reply, event.call_id, (part) =>
          part.effect === effect ? undefined : { ...part, effect },
        );
      return true;
    }
    case "command_ran":
      return patchCall(state, event.reply, event.call_id, (part) => ({
        ...part,
        ran: {
          contained: event.contained,
          exitCode: event.exit_code ?? undefined,
          timedOut: event.timed_out,
          reached: event.reached,
          refused: event.refused,
        },
      }));
    case "tool_finished":
      state.running.delete(event.call_id);
      setCall(
        state,
        event.reply,
        event.call_id,
        event.name,
        event.is_error ? "failed" : "done",
        stored.seq,
      );
      if (event.is_error && typeof event.content === "string") {
        const reason = spadeStepLine(event.content);
        if (reason)
          patchCall(state, event.reply, event.call_id, (part) =>
            part.state === "failed" && part.reason !== reason ? { ...part, reason } : undefined,
          );
      }
      remembered(state, event.reply, key, event.name, event.content, event.is_error === true);
      if (event.files.length)
        updateReply(state, event.reply, (entry) => ({
          ...entry,
          parts: [...entry.parts, { kind: "files", key: `${key}:files`, paths: event.files }],
        }));
      return true;
    case "shared":
      if (!event.images.length && !event.documents.length) return false;
      return updateReply(state, event.reply, (entry) => ({
        ...entry,
        parts: [
          ...entry.parts,
          { kind: "shared", key, images: event.images, documents: event.documents },
        ],
      }));
    case "question_asked": {
      // A call that stopped to ask the person (its sign-in to reconnect) runs no longer: the bot
      // waits on them, as for any question.
      if (state.running.delete(event.call_id))
        setCall(state, event.reply, event.call_id, undefined, "waiting");
      const questions = spadeCardQuestions(event.questions, event.question);
      // A call held on a Reconnect card that was refused again asks again, in the same place.
      const again = spadeConnectOf(questions)?.retry === true;
      const known = updateQuestion(state, event.call_id, (card) =>
        again && card.standing !== "waiting"
          ? { ...card, questions, standing: "waiting", answers: undefined, typed: false }
          : card,
      );
      if (known) {
        if (again && state.open?.reply === event.reply)
          state.question = { reply: event.reply, callId: event.call_id };
        // Asked again as a replay: the card already stands where it was first asked.
        return again;
      }
      const card: { kind: "question"; key: string } & SpadeQuestionCard = {
        kind: "question",
        key,
        callId: event.call_id,
        questions,
        standing: "waiting",
        answers: undefined,
        typed: false,
        askedForLater: false,
        ...(event.lane ? { lane: { task: event.lane.task, title: event.lane.title } } : {}),
      };
      // A task's card stands on its own where it arrived, open until answered: no reply of main's
      // asked it, so main's turn ending never closes it.
      if (event.lane) steer(state, { ...card, ...stamp(stored) });
      else if (state.open?.reply === event.reply) {
        state.question = { reply: event.reply, callId: event.call_id };
        updateOpen(state, event.reply, (entry) => ({ ...entry, parts: [...entry.parts, card] }));
      } else steer(state, { ...card, standing: "closed", ...stamp(stored) });
      return true;
    }
    case "question_deferred": {
      if (state.question?.callId === event.call_id) state.question = undefined;
      const open = updateQuestion(state, event.call_id, (card) =>
        card.standing === "waiting" || card.standing === "closed"
          ? { ...card, standing: "deferred", askedForLater: event.by_bot === true }
          : undefined,
      );
      if (open) state.forLater.add(event.call_id);
      return open;
    }
    case "question_answered":
      if (state.question?.callId === event.call_id) state.question = undefined;
      state.forLater.delete(event.call_id);
      return updateQuestion(state, event.call_id, (card) => ({
        ...card,
        standing: "answered",
        answers: event.answers,
        typed: card.typed || event.typed === true,
      }));
    case "question_dismissed":
      if (state.question?.callId === event.call_id) state.question = undefined;
      state.forLater.delete(event.call_id);
      return updateQuestion(state, event.call_id, (card) => ({ ...card, standing: "dismissed" }));
    case "job_started": {
      // A message to another bot: its turn's card with that bot, where the first was sent.
      const talk =
        event.name === spadeBotMessageTool && spadeTalkStarted(state, key, event, stored);
      if (talk) steer(state, talk);
      if (event.name === spadeHelperTool)
        // Its line, where it started: the reply's later words read below it.
        steer(state, {
          kind: "helper",
          key,
          job: event.job,
          task: spadeHelperTask(state.calls.get(event.job)?.arguments),
          outcome: undefined,
          result: "",
          ...stamp(stored),
        });
      state.jobs.set(event.job, {
        name: event.name,
        agents: delegatedTasks(state.calls.get(event.job)?.arguments),
        reply: event.reply,
        ...(stored.at > 0 ? { startedAt: stored.at } : {}),
      });
      return true;
    }
    case "contract_ended":
      return spadeContractEnded(state.entries, event);
    case "contract_called":
      steer(state, spadeContractCalled(key, event, stamp(stored).at, state));
      return true;
    case "job_finished": {
      state.jobs.delete(event.job);
      const stopped = state.stopping.delete(event.job);
      const outcome = event.is_error ? (stopped ? "stopped" : "failed") : "done";
      // An ended helper asks nothing more.
      state.approvals = state.approvals.filter((approval) => approval.helper?.job !== event.job);
      const at = state.entries.findIndex(
        (entry) => entry.kind === "helper" && entry.job === event.job,
      );
      const line = state.entries[at];
      if (line?.kind === "helper") {
        state.entries[at] = { ...line, outcome, result: event.content ?? "" };
        return true;
      }
      // A contract call's or a message's card settles with what came back; that result opens
      // a reply, as any.
      const end = { job: event.job, content: event.content ?? "", stopped, at: stamp(stored).at };
      if (spadeContractFinished(state.entries, end)) return true;
      if (spadeTalkFinished(state.entries, { ...end, error: event.is_error === true })) return true;
      // Its result goes to Spade like a message: what Spade says about it reads below it.
      steer(state, { kind: "job", key, name: event.name, outcome, files: event.files });
      return true;
    }
    case "call_reviewed": {
      // A refusal returns to the bot as `Not run: <reason>`; its step says so (ADR 0163).
      if (event.verdict === "refuse") return refuseCall(state, event.call_id, event.reason);
      if (event.verdict === "allow" && event.reply && event.model)
        return patchCall(state, event.reply, event.call_id, (part) =>
          part.reviewedAllow ? undefined : { ...part, reviewedAllow: true },
        );
      if (event.verdict !== "escalate") return false;
      state.reviews.set(event.call_id, event.reason);
      updateRequest(state, event.call_id, (request) => ({ ...request, reason: event.reason }));
      const at = state.approvals.findIndex((approval) => approval.callId === event.call_id);
      const asked = state.approvals[at];
      if (!asked) return false;
      state.approvals = state.approvals.with(at, { ...asked, reason: event.reason });
      return true;
    }
    case "reply_finished":
      return closeReply(state, event.reply, { kind: "finished" }, event.text, stored.seq);
    case "reply_stopped":
      return closeReply(state, event.reply, { kind: "stopped" }, event.text, stored.seq);
    case "reply_failed":
      return closeReply(
        state,
        event.reply,
        {
          kind: "failed",
          error: event.error,
          failure: event.kind,
          endpoint: event.endpoint ?? undefined,
        },
        event.text,
        stored.seq,
      );
    case "reply_interrupted":
      return closeReply(state, event.reply, { kind: "interrupted" }, event.text, stored.seq);
    case "reply_retried": {
      // The next reply answers the same turn in its place: the failure goes, and so do the words
      // its failed call left unfinished (no step stored them), which the model no longer reads
      // either; what its finished steps said and did stays.
      const index = replyAt(state, event.reply);
      const entry = index === undefined ? undefined : state.entries[index];
      if (index === undefined || entry?.kind !== "reply" || entry.end?.kind !== "failed")
        return false;
      const parts = entry.parts.filter((part) => part.key !== `${entry.key}:end`);
      state.entries[index] = { ...entry, parts, end: { kind: "finished" } };
      return true;
    }
    case "task_paused":
      state.entries.push({ kind: "task-paused", key, reason: event.reason, steps: event.steps });
      return true;
    case "context_compacted":
      state.entries.push({ kind: "compacted", key });
      return true;
    case "computer_handed_back":
      state.entries.push({
        kind: "handback",
        key,
        text: event.text,
        data: (event.data ?? []).filter((item): item is string => typeof item === "string"),
      });
      return true;
    // Stop's own record: the reply's end and the jobs' ends that follow it say what happened.
    case "stop_requested": {
      for (const job of event.jobs) state.stopping.add(job);
      for (const [job, running] of state.jobs)
        if (event.reply && running.reply === event.reply) state.stopping.add(job);
      // An approval for a stopped reply can no longer be answered.
      const before = state.approvals.length;
      if (event.reply) state.approvals = state.approvals.filter((a) => a.reply !== event.reply);
      const asked = state.question !== undefined && state.question.reply === event.reply;
      if (asked && state.question) {
        const { callId } = state.question;
        updateQuestion(state, callId, (card) =>
          card.standing === "waiting" ? { ...card, standing: "closed" } : undefined,
        );
        state.question = undefined;
      }
      return state.approvals.length !== before || asked;
    }
    case "lane_requests_closed":
      return closeLaneRequests(state, event.calls);
    case "lane_message":
      steer(state, {
        kind: "lane-message",
        key,
        text: event.text,
        untrusted: event.untrusted,
        ...stamp(stored),
      });
      return true;
    case "renamed":
      if (state.title === event.title) return false;
      state.title = event.title;
      return true;
    case "agent_configured": {
      // Only the bot's own rewrites show; the person's edits are theirs, already seen.
      const change = event.change;
      if (!change || change.by !== "bot") return false;
      steer(state, {
        kind: "task-changed",
        key,
        task: event.task,
        previous: change.previous,
        why: change.why,
        ...stamp(stored),
      });
      return true;
    }
    case "model_replaced":
      steer(state, {
        kind: "quiet",
        key,
        quiet: { kind: "model-replaced", line: event.line },
        ...stamp(stored),
      });
      return true;
    case "bot_made":
      steer(state, {
        kind: "made",
        key,
        bot: event.bot,
        name: event.name,
        task: event.task,
        ...stamp(stored),
      });
      return true;
    case "card_shown": {
      const row = spadeCardShown(event);
      if (!row) return false;
      const at = cardAt(state, event.card);
      const placed = at === undefined ? undefined : state.entries[at];
      if (at !== undefined && placed?.kind === "card") {
        // A replayed or older version never draws over a newer one.
        if (placed.version >= row.version) return false;
        state.entries[at] = { ...placed, ...row };
        return true;
      }
      steer(state, { kind: "card", key, ...row, ...stamp(stored) });
      return true;
    }
    case "notice_sent": {
      const row = spadeNoticeSent(event);
      if (!row) return false;
      steer(state, { kind: "notice", key, ...row, ...stamp(stored) });
      return true;
    }
    case "card_action": {
      const at = cardAt(state, event.card);
      const placed = at === undefined ? undefined : state.entries[at];
      const next = placed?.kind === "card" ? spadeCardChosen(placed, event) : undefined;
      if (at === undefined || !placed || !next) return false;
      state.entries[at] = { ...placed, ...next };
      return true;
    }
    case "panel_updated":
      state.panels.set(event.surface, event.data);
      return true;
    case "panel_action":
      // Where it came in: the page's own, or the person's confirm.
      steer(state, {
        kind: "quiet",
        key,
        quiet: { kind: "panel-action", label: event.label || event.action, by: event.by },
        ...stamp(stored),
      });
      return true;
    case "club_added":
      steer(state, {
        kind: "club-added",
        key,
        club: event.club,
        clubName: event.club_name,
        bot: event.bot,
        botName: event.bot_name,
        ...stamp(stored),
      });
      return true;
    case "profile_changed": {
      if (event.by !== "bot") return false;
      const first = !state.entries.some((entry) => entry.kind === "named");
      steer(state, {
        kind: "named",
        key,
        name: event.name,
        face: event.face,
        first,
        ...stamp(stored),
      });
      return true;
    }
  }
}

/**
 * A message while a reply is open steers it: the reply carries on under the message, so what
 * Spade says next reads after it. The open step's words so far move down with it.
 */
/** The line of the helper running `job`, if this conversation shows one. */
