import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { z } from "zod";
import {
  eventChannel,
  events,
  requestChannel,
  requests,
  type EventChannel,
  type EventOf,
  type RequestChannel,
  type ResultOf,
} from "../shared/channels.ts";
import { isAppUrl } from "./csp.ts";

export type Handlers = {
  [C in RequestChannel]: (
    request: z.output<(typeof requests)[C]["request"]>,
    /** The app window's renderer that asked; absent when the main process asks (the menu). */
    sender?: WebContents,
  ) => ResultOf<C> | Promise<ResultOf<C>>;
};

/**
 * Registers every bridge request. A request is served only for the app's own top frame
 * (never a subframe, a browser view or a navigated-away page) and only after its payload
 * parses; results are parsed too, so the bridge contract holds in both directions.
 */
export function registerHandlers(options: {
  rendererUrl: string;
  isAppWindow(contents: WebContents): boolean;
  handlers: Handlers;
}): () => void {
  const trusted = (event: IpcMainInvokeEvent) =>
    options.isAppWindow(event.sender) &&
    event.senderFrame !== null &&
    event.senderFrame.parent === null &&
    isAppUrl(event.senderFrame.url, options.rendererUrl);
  const names = Object.keys(requests) as RequestChannel[];
  for (const name of names) {
    const spec = requests[name];
    ipcMain.handle(requestChannel(name), async (event, payload: unknown) => {
      if (!trusted(event)) throw new Error("Untrusted sender");
      const request = (spec.request as z.ZodType).parse(payload);
      const handler = options.handlers[name] as (request: unknown, sender: WebContents) => unknown;
      return (spec.result as z.ZodType).parse(await handler(request, event.sender));
    });
  }
  return () => {
    for (const name of names) ipcMain.removeHandler(requestChannel(name));
  };
}

/** Sends a parsed event to the renderer, if it is alive. */
export function emit<C extends EventChannel>(
  contents: WebContents | undefined,
  channel: C,
  value: EventOf<C>,
): void {
  if (!contents || contents.isDestroyed()) return;
  contents.send(eventChannel(channel), (events[channel] as z.ZodType).parse(value));
}
