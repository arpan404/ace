import { createTextRedactor } from "@ace/redaction";
import { htmlToolkit, type HtmlPublicationPort } from "@ace/mcp-server";
import { ItemId } from "@ace/protocol";
import { resolveHtmlMode } from "@ace/html";
import type { ContextService } from "@ace/context";
import type { Store } from "./store.ts";
import { toolAttachment } from "./tool-result-content.ts";

export function htmlPublication(runtime: {
  store: Store;
  context(): ContextService | undefined;
  now(): number;
  id(): string;
  redactTitle?: (title: string) => string;
}) {
  // The reference is indexed independently of the windowed in-memory transcript.
  runtime.store
    .statement(`CREATE INDEX IF NOT EXISTS html_attachment ON items(
    thread_id,json_extract(item,'$.visualization.document.sha256'))
    WHERE json_extract(item,'$.type')='html'`)
    .run();
  const port: HtmlPublicationPort = {
    async publish(caller, input, signal) {
      signal.throwIfAborted();
      const context = runtime.context();
      if (!context || !runtime.store.hasLiveThread(caller.threadId))
        throw new Error("HTML publication unavailable");
      // text/plain prevents the authenticated attachment endpoint from serving executable HTML.
      const document = await toolAttachment(context, caller, Buffer.from(input.html), {
        name: "visualization.html",
        mimeType: "text/plain",
      });
      signal.throwIfAborted();
      if (!runtime.store.hasLiveThread(caller.threadId)) throw new Error("Thread deleted");
      const itemId = ItemId.parse(runtime.id());
      const at = runtime.now();
      runtime.store.appendEvents(
        caller.threadId,
        [
          {
            type: "item.created",
            item: {
              type: "html",
              id: itemId,
              agentId: caller.agentId,
              createdAt: at,
              complete: true,
              raw: [],
              visualization: {
                title:
                  (runtime.redactTitle ?? createTextRedactor({}))(input.title.trim()).slice(
                    0,
                    160,
                  ) || "Visualization",
                document,
                ...(input.height === undefined ? {} : { height: input.height }),
                mode: resolveHtmlMode(input.html, input.mode),
              },
            },
          },
        ],
        at,
      );
      return { itemId };
    },
  };
  return htmlToolkit(port);
}

export function retainsHtml(store: Store, thread: string, hash: string): boolean {
  return Boolean(
    store
      .statement(`SELECT 1 FROM items WHERE thread_id=?
    AND json_extract(item,'$.type')='html'
    AND json_extract(item,'$.visualization.document.sha256')=? LIMIT 1`)
      .get(thread, hash),
  );
}
