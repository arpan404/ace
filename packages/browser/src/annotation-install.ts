import { z } from "zod";
import {
  annotationBindingName,
  annotationInstallExpression,
  annotationTeardownExpression,
  annotationWorldName,
} from "@ace/browser-annotate";
import type { BrowserAnnotationConfig } from "@ace/protocol";
import type { BrowserCdp } from "./backend.ts";

const FrameTree = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) });
const World = z.object({ executionContextId: z.number().int() });
const Evaluated = z.object({
  result: z.object({ value: z.unknown().optional(), objectId: z.string().optional() }),
  exceptionDetails: z
    .object({
      text: z.string().optional(),
      exception: z.object({ description: z.string().optional() }).optional(),
    })
    .optional(),
});
const BindingCall = z.object({
  name: z.string(),
  payload: z.string(),
  executionContextId: z.number().int(),
});
const Navigated = z.object({ frame: z.object({ parentId: z.string().optional() }) });
/** A saved annotation is a few KiB; anything near this is not our overlay talking. */
const payloadLimit = 256 * 1024;

export interface InstalledOverlay {
  contextId: number;
  documentId: string;
  /** Stop listening; the page side is removed by `removeOverlay`. */
  detach(): void;
}

/**
 * Evaluate in the overlay's isolated world. CDP evaluation is not subject to the page's CSP,
 * and the world's globals are invisible to page scripts.
 */
export async function evaluateInWorld(
  cdp: BrowserCdp,
  contextId: number,
  expression: string,
  options: { awaitPromise?: boolean; byValue?: boolean } = {},
): Promise<z.infer<typeof Evaluated>["result"]> {
  const evaluated = Evaluated.parse(
    await cdp.send("Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: options.byValue ?? true,
      awaitPromise: options.awaitPromise ?? false,
      silent: true,
    }),
  );
  const failure = evaluated.exceptionDetails;
  if (failure)
    throw new Error(
      `The page's annotation overlay failed: ${failure.exception?.description ?? failure.text ?? "exception"}`.slice(
        0,
        512,
      ),
    );
  return evaluated.result;
}

/**
 * Install the overlay in the top document: register the binding for the `ace-annotate` world
 * only, create that world, then evaluate the bundle in it. Events whose context or binding
 * differ are ignored, so the page's main world can never speak for the overlay.
 */
export async function installOverlay(
  cdp: BrowserCdp,
  config: Partial<BrowserAnnotationConfig>,
  handlers: { event(payload: string): void; navigated(): void },
): Promise<InstalledOverlay> {
  let contextId: number | undefined;
  const binding = (raw: unknown) => {
    const call = BindingCall.safeParse(raw);
    if (
      !call.success ||
      call.data.name !== annotationBindingName ||
      call.data.executionContextId !== contextId ||
      call.data.payload.length > payloadLimit
    )
      return;
    handlers.event(call.data.payload);
  };
  const navigated = (raw: unknown) => {
    const frame = Navigated.safeParse(raw);
    if (frame.success && !frame.data.frame.parentId) handlers.navigated();
  };
  const detach = () => {
    cdp.off("Runtime.bindingCalled", binding);
    cdp.off("Page.frameNavigated", navigated);
  };
  cdp.on("Runtime.bindingCalled", binding);
  cdp.on("Page.frameNavigated", navigated);
  try {
    // Bindings reach contexts only through an enabled Runtime domain on this CDP session.
    await cdp.send("Runtime.enable");
    await cdp.send("Runtime.addBinding", {
      name: annotationBindingName,
      executionContextName: annotationWorldName,
    });
    const frameId = FrameTree.parse(await cdp.send("Page.getFrameTree")).frameTree.frame.id;
    contextId = World.parse(
      await cdp.send("Page.createIsolatedWorld", {
        frameId,
        worldName: annotationWorldName,
        grantUniveralAccess: false,
      }),
    ).executionContextId;
    const documentId = z
      .string()
      .min(1)
      .max(256)
      .parse((await evaluateInWorld(cdp, contextId, annotationInstallExpression(config))).value);
    return { contextId, documentId, detach };
  } catch (error) {
    detach();
    throw error;
  }
}

/** Best effort: the document may already be gone. */
export async function removeOverlay(cdp: BrowserCdp, contextId: number): Promise<void> {
  await evaluateInWorld(cdp, contextId, annotationTeardownExpression).catch(() => {});
  await cdp.send("Runtime.removeBinding", { name: annotationBindingName }).catch(() => {});
}
