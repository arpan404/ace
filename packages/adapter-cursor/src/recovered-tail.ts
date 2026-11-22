import type { Fact, Key } from "@ace/core";
import { object, string } from "./contracts.ts";

/** What one run's recovered tail has said so far. */
interface Tail {
  text: string;
  tools: string[];
}
const maxTools = 32;
const maxText = 1_048_576;

/**
 * Folds a cut-off run's messages, read back from the SDK store after a restart, into facts
 * (ADR 0043, amendment of 2026-11-22). The SDK stores one message per streamed update; text
 * chunks join one recovered answer, tool calls are named in the recovery notice. Pure.
 */
export class RecoveredTail {
  private tails = new Map<string, Tail>();
  private max: number;
  constructor(maxRuns: number) {
    this.max = maxRuns;
  }
  private tail(runId: string): Tail {
    let tail = this.tails.get(runId);
    if (!tail) {
      if (this.tails.size >= this.max) throw new Error("SDK recovered run budget exceeded");
      tail = { text: "", tools: [] };
      this.tails.set(runId, tail);
    }
    return tail;
  }
  private answer(agent: Key, item: string, text: string): Fact {
    return {
      type: "item.upsert",
      agent,
      item,
      draft: {
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text }],
        complete: true,
      },
    };
  }
  /** One stored SDK message of `runId`; the recovered answer so far, when it said text. */
  add(runId: string, message: unknown, agent: Key, namespace: string): Fact[] {
    const body = object(message);
    const tail = this.tail(runId);
    if (body.type === "assistant") {
      const content = object(body.message).content;
      const text = (Array.isArray(content) ? content : [])
        .map((part) => (object(part).type === "text" ? (string(object(part).text) ?? "") : ""))
        .join("");
      if (!text || tail.text.length + text.length > maxText) return [];
      tail.text += text;
      return [this.answer(agent, `${namespace}:recovered:${runId}`, tail.text)];
    }
    if (body.type === "tool_call" && body.status !== "running") {
      const name = string(body.name)?.slice(0, 80) ?? "tool";
      if (tail.tools.length < maxTools) tail.tools.push(`${name} (${string(body.status) ?? "?"})`);
    }
    return [];
  }
  /**
   * Ends `runId`'s tail: the stored result stands in for the answer when no text was
   * recovered, and the notice says what came back and from where.
   */
  finish(
    runId: string,
    status: string,
    result: string | undefined,
    agent: Key,
    namespace: string,
  ): { facts: Fact[]; text: string } {
    const tail = this.tails.get(runId) ?? { text: "", tools: [] };
    this.tails.delete(runId);
    const facts: Fact[] = [];
    if (!tail.text && result)
      facts.push(this.answer(agent, `${namespace}:recovered:${runId}`, result));
    const recovered = Boolean(tail.text || result || tail.tools.length);
    const what =
      status === "finished"
        ? "Cursor finished this run while ace was restarting."
        : status === "running" || status === "queued"
          ? "ace restarted while this Cursor run was working, so it was stopped. Nothing was sent again."
          : `Cursor's run ended (${status}) while ace was restarting.`;
    const tools = tail.tools.length ? ` Tools it ran meanwhile: ${tail.tools.join(", ")}.` : "";
    const source = recovered
      ? " What it did after the live stream was cut off is recovered from Cursor's saved session."
      : "";
    return { facts, text: `${what}${source}${tools}` };
  }
}
