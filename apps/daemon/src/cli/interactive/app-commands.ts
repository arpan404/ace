import { randomUUID } from "node:crypto";
import type { ThreadSubscription } from "@ace/client";
import type { CommandPayload } from "@ace/protocol";
import { words, type App } from "./app-context.ts";
import { answerOutcome } from "./answer-outcome.ts";

/**
 * Commands the interactive shell sends, and the answers it follows (ADR 0176 §9): an answer
 * the daemon admitted is claimed only once its request closes (`answerOutcome`); one that
 * didn't land shows again in the requests walk.
 */
export interface Commands {
  submit(payload: CommandPayload, doneText: string): Promise<void>;
  /** Settles the answers whose requests closed; each says so in a flash. */
  check(): void;
  close(): void;
}

interface Answer {
  readonly id: string;
  readonly lease: ThreadSubscription;
  readonly stop: () => void;
  readonly sentAt: number;
  readonly done: string;
}

export function commands(app: App): Commands {
  const answers: Answer[] = [];
  const unhide = (id: string) => {
    app.requests = {
      ...app.requests,
      answered: app.requests.answered.filter((answered) => answered !== id),
    };
  };
  /** The thread an open request belongs to, from the stores the views follow. */
  const requestThread = (id: string): string | undefined => {
    const listed = app.live?.requests().find((open) => open.interaction.id === id);
    if (listed) return listed.interaction.threadId;
    return app.live?.followed("attach")?.store.interaction(id)?.threadId;
  };
  return {
    async submit(payload, doneText) {
      const session = app.session;
      if (!session) return;
      const { command } = await import("../mutations.ts");
      const answering = payload.type === "interaction.resolve" ? payload.interactionId : undefined;
      const thread = answering ? requestThread(answering) : undefined;
      if (answering) app.flash("Sending your answer…");
      try {
        await command(session.client, payload, randomUUID(), session.signal);
      } catch (error) {
        if (answering) unhide(answering);
        app.flash(words(error, "That didn't go through."));
        return;
      }
      // Admitted isn't answered: the words wait for the request to close.
      if (answering && thread) {
        const lease = session.client.thread(thread);
        answers.push({
          id: answering,
          lease,
          stop: lease.store.observe(app.schedule),
          sentAt: Date.now(),
          done: doneText,
        });
        return app.schedule();
      }
      if (doneText) app.flash(doneText);
    },
    check() {
      // Backwards, since a settled answer leaves the list.
      for (let index = answers.length - 1; index >= 0; index--) {
        const answer = answers[index];
        if (!answer) continue;
        const outcome = answerOutcome({
          state: answer.lease.store.interaction(answer.id)?.state,
          sentAt: answer.sentAt,
          now: Date.now(),
          done: answer.done,
        });
        if (outcome.kind === "waiting") continue;
        answers.splice(index, 1);
        answer.stop();
        answer.lease.release();
        if (outcome.kind === "failed") unhide(answer.id);
        app.flash(outcome.text);
      }
    },
    close() {
      for (const answer of answers) {
        answer.stop();
        answer.lease.release();
      }
      answers.length = 0;
    },
  };
}
