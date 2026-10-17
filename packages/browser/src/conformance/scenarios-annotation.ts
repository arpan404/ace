import { expect } from "vitest";
import { z } from "zod";
import { BrowserAnnotationEvent, type BrowserServerMessage } from "@ace/protocol";
import { connectBrowser } from "../bridge.ts";
import type { ConformancePage, ConformanceScenario } from "./engine.ts";
import { eventually, visit } from "./scenario-support.ts";

const Box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

/** A person on a client connection, over the same bridge the apps use. */
function person(page: ConformancePage) {
  const messages: BrowserServerMessage[] = [];
  const bridge = connectBrowser(page.service, {
    connectionId: "conformance-person",
    authorize: () => true,
    send: (message) => {
      messages.push(message);
      return true;
    },
  });
  let request = 0;
  const call = async (message: Record<string, unknown>): Promise<unknown> => {
    const requestId = `conformance-${++request}`;
    await bridge.handle({ requestId, threadId: page.threadId, ...message });
    const reply = messages.find(
      (candidate) => candidate.type === "browser.result" && candidate.requestId === requestId,
    );
    if (reply?.type !== "browser.result") throw new Error("No browser result");
    if (!reply.ok) throw new Error(reply.error);
    return reply.result;
  };
  const input = (value: Record<string, unknown>) => call({ type: "browser.input", input: value });
  const events = () =>
    messages.flatMap((message) =>
      message.type === "browser.annotation" ? [BrowserAnnotationEvent.parse(message.event)] : [],
    );
  return {
    call,
    input,
    event: (kind: BrowserAnnotationEvent["kind"]) =>
      eventually(() => {
        const found = events().find((event) => event.kind === kind);
        if (!found) throw new Error(`No ${kind} annotation event yet`);
        return found;
      }),
  };
}

export const annotationScenarios: ConformanceScenario[] = [
  {
    id: "annotation",
    title: "the annotation overlay mounts, and a click pins a comment to the element",
    async run(page) {
      await visit(page, "/annotate", "Pin this paragraph");
      const box = Box.parse(
        await page.evaluate(
          "(() => { const r = document.querySelector('p.lead').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()",
        ),
      );
      const human = person(page);
      await human.call({ type: "browser.subscribe" });
      // Annotate mode is the person's (ADR 0082); they hold the page first.
      await human.call({ type: "browser.takeover" });
      await human.call({
        type: "browser.execute",
        command: { action: "annotate", operation: "start" },
      });
      await human.event("ready");
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await human.input({ kind: "mouse", event: "mouseMoved", x, y, button: "none" });
      for (const event of ["mousePressed", "mouseReleased"])
        await human.input({ kind: "mouse", event, x, y });
      await human.input({ kind: "key", event: "char", key: "Tighten this" });
      for (const event of ["keyDown", "keyUp"])
        await human.input({ kind: "key", event, key: "Enter", code: "Enter", modifiers: 0 });
      const saved = await human.event("saved");
      expect(saved).toMatchObject({
        annotation: {
          number: 1,
          comment: "Tighten this",
          element: { tag: "p", text: "Pin this paragraph" },
        },
      });
      // The pinning click belonged to the overlay, never to the page.
      expect(
        await human.call({
          type: "browser.execute",
          command: { action: "evaluate", expression: "window.pageClicks" },
        }),
      ).toBe(0);
    },
  },
];
