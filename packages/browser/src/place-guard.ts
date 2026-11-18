import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The place a caller's gate held a command to (`expect`, ADR 0171 amendment 3), enforced where
 * every input leaves for the page: each backend's transport calls `beforeDispatch` right before
 * it sends a CDP command or an input operation, for the page, its frames and every session the
 * backend holds, whichever helper captured the session. The command runs inside `holdTo`, so
 * the check follows it (and only it) through every await; the person's own input and other
 * commands run outside it and are never held to an agent's place.
 */
interface Hold {
  /** Throws `place_changed` unless the tab is at the place, at `url` when the page reported it. */
  check(url?: string): void;
  /** Presses, keys and touches begun under this hold and not yet let go. */
  begun: Set<string>;
}

const holding = new AsyncLocalStorage<Hold>();

/** The hold a caller is under, as a transport keeps it for the moment its command is sent. */
export type HeldScope = Hold | undefined;

/** The hold the caller is under now (none outside a held command). */
export function currentHold(): HeldScope {
  return holding.getStore();
}

/**
 * Runs `work` under `scope`, as the command that queued it was: a transport's slot callback
 * runs whenever a slot frees, from whatever context freed it, so it restores its own caller's.
 */
export function within<T>(scope: HeldScope, work: () => T): T {
  return scope ? holding.run(scope, work) : holding.exit(work);
}

/** Runs `work` held to a place: `check` throws `place_changed` when the tab moved on. */
export function holdTo<T>(check: (url?: string) => void, work: () => Promise<T>): Promise<T> {
  return holding.run({ check, begun: new Set() }, work);
}

/** CDP methods outside `Input.*` that change what the page holds or where it is. */
const moves: ReadonlySet<string> = new Set([
  "DOM.setFileInputFiles",
  "Page.navigate",
  "Page.navigateToHistoryEntry",
  "Page.reload",
  "Page.handleJavaScriptDialog",
]);

/** What a transport does with one outgoing command. */
export type Dispatch =
  /** Send it. */
  | { kind: "send" }
  /**
   * The place changed after a press, key or touch began: the gesture's end must never reach
   * the new page (its mouseup, click, keyup or drop would land there). Don't send it; send
   * `instead` if given (cancelling a drag), then fail the command with `error`.
   */
  | { kind: "drop"; instead?: { method: string; params: Record<string, unknown> }; error: unknown };

/** The gesture a CDP input event begins or ends, and whether it ends one. */
function gesture(
  method: string,
  params?: Record<string, unknown>,
): { key: string; ends: boolean } | undefined {
  const type = params?.["type"];
  if (method === "Input.dispatchMouseEvent") {
    const key = `mouse:${String(params?.["button"] ?? "left")}`;
    if (type === "mousePressed") return { key, ends: false };
    if (type === "mouseReleased") return { key, ends: true };
    return undefined;
  }
  if (method === "Input.dispatchKeyEvent") {
    const key = `key:${String(params?.["code"] ?? params?.["key"] ?? "")}`;
    if (type === "keyDown" || type === "rawKeyDown") return { key, ends: false };
    if (type === "keyUp") return { key, ends: true };
    return undefined;
  }
  if (method === "Input.dispatchTouchEvent") {
    if (type === "touchStart") return { key: "touch", ends: false };
    if (type === "touchEnd") return { key: "touch", ends: true };
    return undefined;
  }
  if (method === "Input.dispatchDragEvent" && type === "drop") return { key: "drag", ends: true };
  return undefined;
}

/** Whether a CDP command sends the page input or moves it. */
export function dispatchesInput(method: string): boolean {
  return method.startsWith("Input.") || moves.has(method);
}

/**
 * The check every transport runs right before a command leaves for the page. Outside a held
 * command, or for a read, it sends. Held, an input checks the place first (throwing
 * `place_changed`); the end of a gesture begun under the hold that finds the place changed is
 * dropped, with a drag cancelled, so nothing activates on the page the tab moved to.
 */
export function beforeDispatch(
  method: string,
  params?: Record<string, unknown>,
  /** Where the page says it is, read right before this input; unknown: the backend's report. */
  url?: string,
): Dispatch {
  const hold = holding.getStore();
  if (!hold || !dispatchesInput(method)) return { kind: "send" };
  const part = gesture(method, params);
  if (part?.ends) {
    try {
      hold.check(url);
    } catch (error) {
      hold.begun.delete(part.key);
      return {
        kind: "drop",
        error,
        ...(part.key === "mouse:left" || part.key === "drag"
          ? { instead: { method: "Input.cancelDragging", params: {} } }
          : {}),
      };
    }
    hold.begun.delete(part.key);
    return { kind: "send" };
  }
  hold.check(url);
  if (part) hold.begun.add(part.key);
  return { kind: "send" };
}

/**
 * The same check for an input a backend sends outside CDP (the desktop's key press and
 * navigation): it throws `place_changed` when the tab moved on.
 */
export function beforeInputOperation(url?: string): void {
  holding.getStore()?.check(url);
}

/** Whether the caller is held to a place now. */
export function held(): boolean {
  return holding.getStore() !== undefined;
}

/**
 * Where a page is, asked of the page itself right before a held input: its renderer answers
 * after it handled every earlier input, so a route a handler just changed is already there,
 * before the browser's own report of it arrives. A frame answers null (its address isn't the
 * tab's): the backend's report decides there.
 */
export const LOCATION_PROBE = "window === top ? location.href : null";

/**
 * The page's own answer to `LOCATION_PROBE`: its address, or `undefined` for a frame or a page
 * that gave no value. A page that can't answer (it is mid-navigation, or gone) fails the held
 * input with `place_changed`: what it would land on is unknown.
 */
export async function pageLocation(
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
): Promise<string | undefined> {
  let answer: unknown;
  try {
    answer = await send("Runtime.evaluate", { expression: LOCATION_PROBE, returnByValue: true });
  } catch {
    holding.getStore()?.check("about:unknown");
    return undefined;
  }
  const result =
    typeof answer === "object" && answer !== null ? Reflect.get(answer, "result") : undefined;
  const value =
    typeof result === "object" && result !== null ? Reflect.get(result, "value") : undefined;
  return typeof value === "string" ? value : undefined;
}

/** Runs `send` for a command unless the hold drops it (then fails with the hold's error). */
export async function dispatched<T>(
  method: string,
  params: Record<string, unknown> | undefined,
  send: (method: string, params?: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const url = held() && dispatchesInput(method) ? await pageLocation(send) : undefined;
  const decided = beforeDispatch(method, params, url);
  if (decided.kind === "send") return send(method, params);
  if (decided.instead) await send(decided.instead.method, decided.instead.params).catch(() => {});
  throw decided.error;
}
