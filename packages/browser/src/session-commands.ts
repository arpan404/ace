import { z } from "zod";
import { pageHistory, traverseHistory, findPageText } from "./page-navigation.ts";
import {
  BrowserCommand,
  type BrowserState,
  type BrowserOriginBlock,
  type BrowserArtifact,
} from "@ace/protocol";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { BrowserBackendPage } from "./backend.ts";
import { pngScreenshot, printPdf, screenshotRegion } from "./page-capture.ts";
import { captureAtSizes } from "./responsive-capture.ts";
import { BrowserActionError } from "./action-error.ts";
import { waitForBrowser } from "./wait.ts";
import { BrowserOriginError, browserOrigin } from "./policy.ts";
import { NavigationTask } from "./navigation.ts";
import { documentLoaded, networkIdle } from "./load-wait.ts";
import { evaluatePage, evaluateReadOnly } from "./evaluation.ts";
import { evaluateWithoutStorage } from "./storage-guard.ts";
import { measureBrowserInteraction } from "./measurement.ts";
import { uploadPaths } from "./uploads.ts";
import { dragRefs } from "./drag.ts";
import { keptText } from "./typing.ts";
import { executeAnnotation } from "./annotation-commands.ts";
import { emulateDevice, executePageTool, resizePage, type TabView } from "./page-tools.ts";
import { executeContextCommand } from "./page-context.ts";
import type { AnnotationSession } from "./annotation-session.ts";
import type { SnapshotRefs } from "./refs.ts";
import type { SessionLogs } from "./logs.ts";
import type { NavigationPolicies } from "./policy-waits.ts";
import type { Actor, SessionOptions } from "./session-options.ts";
/** The largest screenshot a person's request gets back inline (base64), besides the file. */
const inlineScreenshotBytes = 3 * 1024 * 1024;
/** Commands that act on one tab; tab structure, downloads and extensions belong to the thread. */
export type TabCommand = Exclude<BrowserCommand, { action: "tabs" | "downloads" | "extensions" }>;
/** Parses a command that runs on a tab, such as a measured interaction or a popup navigation. */
export function tabCommand(raw: unknown): TabCommand {
  const command = BrowserCommand.parse(raw);
  if (
    command.action === "tabs" ||
    command.action === "downloads" ||
    command.action === "extensions"
  )
    throw new BrowserActionError("invalid_arguments");
  return command;
}
interface CommandCursor {
  point(at: { x: number; y: number }, click?: boolean): Promise<void>;
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>;
  typing(field: { x: number; y: number; width: number; height: number }): Promise<void>;
  scroll(dx: number, dy: number): void;
}
interface CommandContext {
  options: SessionOptions;
  /** The tab this command runs on, and its page. */
  tabId: string;
  page: BrowserBackendPage;
  answer(dialogId: string, accept: boolean, promptText?: string): Promise<void>;
  beforeInput?: (() => void) | undefined;
  navigate?: (() => Promise<void>) | undefined;
  refs: SnapshotRefs;
  annotation: AnnotationSession;
  /** The tab's device and zoom, kept on the tab and listed with it. */
  view: TabView;
  logs: SessionLogs;
  policies: NavigationPolicies;
  state(): BrowserState;
  read(): void;
  blocked(): BrowserOriginBlock | undefined;
  clearBlocked(): void;
  check(actor: Actor, signal?: AbortSignal, generation?: number): void;
  refDispatch(
    ref: string,
    actor: Actor,
    signal: AbortSignal | undefined,
    generation: number,
  ): { prepare(): void; send(): void };
  /** The person works in this tab now (`presentMs`): agent typing keeps their text and focus. */
  personPresent?(): boolean;
  /** The person used the tab within `quietMs`: an agent's multi-step input stops. */
  personBusy?(): boolean;
  /** An agent pointed at this spot (CSS pixels); viewers draw its cursor there. */
  point?(point: { x: number; y: number }): void;
  /**
   * The agent's cursor in the page, while one is drawn; each resolves once the cursor has
   * landed, so the input that follows happens under it.
   */
  cursor?: CommandCursor | undefined;
  /** Runs a capture with ace's page layers hidden and secret fields masked. */
  capture<T>(work: () => Promise<T>): Promise<T>;
  emit(): void;
  run(
    command: TabCommand,
    actor: Actor,
    signal: AbortSignal | undefined,
    generation: number,
    beforeInput?: () => void,
  ): Promise<unknown>;
  beginRecording(check: () => void, by: Actor): Promise<void>;
  finishRecording(): Promise<BrowserArtifact>;
}
export async function executeBrowserCommand(
  command: TabCommand,
  actor: Actor,
  signal: AbortSignal | undefined,
  generation: number,
  context: CommandContext,
): Promise<unknown> {
  const { dir, id, evaluatePolicy, threadId } = context.options;
  const page = context.page;
  const cdp = page.cdp;
  switch (command.action) {
    case "annotate":
      return executeAnnotation(command, actor, cdp, context.annotation);
    case "annotate_capture":
      // The person's capture goes to the agent: no cursor and no secret in it.
      return context.capture(() => executeAnnotation(command, actor, cdp, context.annotation));
    case "measure_interaction":
      return measureBrowserInteraction(
        {
          interaction: command.interaction,
          observeMs: command.observeMs,
          repeat: command.repeat,
          filmstrip: command.filmstrip,
        },
        {
          threadId,
          backend: page,
          tabId: context.tabId,
          clock: context.options.navigationClock,
          id,
          read: context.read,
          input: (interaction, measurementSignal, beforeInput) =>
            context.run(tabCommand(interaction), actor, measurementSignal, generation, beforeInput),
        },
        signal,
      );
    case "selection": {
      context.read();
      const result = await cdp.send("Runtime.evaluate", {
        expression:
          "(()=>{const e=document.activeElement;return (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) && e.selectionStart!==null ? e.value.slice(e.selectionStart,Math.min(e.selectionEnd??e.selectionStart,e.selectionStart+65536)) : String(getSelection()??'').slice(0,65536)})()",
        returnByValue: true,
      });
      context.read();
      return {
        text: z.object({ result: z.object({ value: z.string().max(65536) }) }).parse(result).result
          .value,
      };
    }
    case "navigation_history":
      return pageHistory(cdp);
    case "history":
      context.check(actor, signal, generation);
      return traverseHistory(cdp, command.direction, () =>
        context.check(actor, signal, generation),
      );
    case "find_text":
      context.read();
      return page.findText
        ? page.findText(command.text, command.forward)
        : findPageText(cdp, command.text, command.forward);
    case "navigate": {
      if (!/^https?:\/\//i.test(command.url) || !browserOrigin(command.url))
        throw new BrowserOriginError(
          command.url,
          "invalid_origin",
          "Browser navigation requires an HTTP(S) URL without credentials",
        );
      const task = new NavigationTask(
        actor.kind === "human",
        command.timeout,
        context.options.navigationClock,
        signal,
      );
      context.policies.start(task);
      context.clearBlocked();
      try {
        const resume = task.pause();
        let allowed: boolean;
        try {
          allowed = await task.run(() =>
            context.options.navigatePolicy(command.url, actor, task.signal),
          );
        } finally {
          resume();
        }
        if (!allowed)
          throw new BrowserOriginError(
            browserOrigin(command.url) ?? command.url,
            browserOrigin(command.url) ? "approval_required" : "invalid_origin",
            "Browser origin refused",
          );
        context.check(actor, task.signal, generation);
        await task.run(() => {
          context.check(actor, task.signal, generation);
          context.beforeInput?.();
          return context.navigate
            ? context.navigate()
            : page.navigate(command.url, command.timeout + 65_000, task.signal);
        });
        // The navigation has reached DOMContentLoaded; later stages share its deadline.
        if (command.waitUntil !== "domcontentloaded")
          await task.run(async () => {
            const clock = context.options.navigationClock;
            await documentLoaded(page, clock, task.signal);
            if (command.waitUntil === "networkidle") await networkIdle(page, clock, task.signal);
          });
        return context.state();
      } catch (error) {
        if (task.blocked)
          throw new BrowserOriginError(
            task.blocked.origin,
            task.blocked.reason,
            error instanceof Error ? error.message : "Browser navigation blocked",
          );
        if (task.deadlineExpired)
          throw new BrowserOriginError(
            task.expiredOrigin ?? browserOrigin(command.url) ?? command.url,
            "timeout",
            error instanceof Error ? error.message : "Browser navigation timed out",
          );
        throw error;
      } finally {
        // Only this page is stopped; sibling sessions share no cancellation.
        if (task.signal.aborted) void page.cdp.send("Page.stopLoading").catch(() => {});
        task.close();
        context.policies.finish(task);
      }
    }
    case "snapshot":
      return {
        tabId: context.tabId,
        ...(await context.refs.snapshot({ ref: command.ref, depth: command.depth })),
      };
    case "find": {
      const snapshot = await context.refs.snapshot();
      return {
        ...snapshot,
        tabId: context.tabId,
        nodes: snapshot.nodes.filter(
          (node) =>
            node.role === command.role &&
            (command.exact ? node.name === command.name : node.name.includes(command.name)),
        ),
      };
    }
    case "dialog":
      context.check(actor, signal, generation);
      await context.answer(command.dialogId, command.accept, command.promptText);
      return { ok: true };
    case "upload": {
      const dispatch = context.refDispatch(command.ref, actor, signal, generation);
      const roots = [dir];
      if (context.options.workspaceRoot) roots.unshift(await context.options.workspaceRoot());
      const files = await uploadPaths({
        files: command.files,
        roots,
        check: dispatch.send,
        ...(context.options.artifactAllowed
          ? { artifactAllowed: context.options.artifactAllowed }
          : {}),
        ...(context.options.uploadPolicy
          ? {
              policy: async (paths) =>
                (await context.options.uploadPolicy?.(paths, signal)) === true,
            }
          : {}),
      });
      dispatch.send();
      await context.refs.upload(command.ref, files, dispatch.prepare);
      return { ok: true };
    }
    case "focus": {
      const dispatch = context.refDispatch(command.ref, actor, signal, generation);
      await context.refs.focus(command.ref, dispatch.prepare);
      dispatch.send();
      return { ok: true };
    }
    case "select": {
      const dispatch = context.refDispatch(command.ref, actor, signal, generation);
      await context.refs.choose(command.ref, command.values, dispatch.prepare);
      dispatch.send();
      return { ok: true };
    }
    case "hover": {
      const dispatch = context.refDispatch(command.ref, actor, signal, generation);
      const { point } = await context.refs.target(command.ref, dispatch.prepare);
      dispatch.send();
      context.point?.(point);
      await context.cursor?.point(point);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      return { ok: true };
    }
    case "drag": {
      const from = context.refDispatch(command.ref, actor, signal, generation),
        to = context.refDispatch(command.toRef, actor, signal, generation);
      const document = context.refs.documentGuard();
      const start = (await context.refs.target(command.ref, from.prepare)).point,
        end = (await context.refs.target(command.toRef, to.prepare)).point;
      context.point?.(end);
      await context.cursor?.drag(start, end);
      await dragRefs(
        cdp,
        start,
        end,
        () => {
          from.send();
          to.send();
          // The person came back mid-drag: the agent lets go rather than drag across them.
          if (context.personBusy?.()) throw new BrowserActionError("human_active");
        },
        () => {
          context.check(actor, undefined, generation);
          document();
        },
        context.beforeInput,
      );
      return { ok: true };
    }
    case "check":
    case "uncheck": {
      const dispatch = context.refDispatch(command.ref, actor, signal, generation);
      const desired = command.action === "check";
      if ((await context.refs.checked(command.ref, dispatch.prepare)) !== desired) {
        const { point } = await context.refs.target(command.ref, dispatch.prepare);
        dispatch.send();
        context.point?.(point);
        await context.cursor?.point(point, true);
        await page.click(point.x, point.y);
        if ((await context.refs.checked(command.ref, dispatch.prepare)) !== desired)
          throw new BrowserActionError("element_unavailable");
      }
      return { ok: true };
    }
    case "network_body":
      if (!page.networkBody) throw new BrowserActionError("not_supported");
      return page.networkBody(command.requestId);
    case "record_start":
      await context.beginRecording(() => context.check(actor, signal, generation), actor);
      return { recording: true };
    case "record_stop":
      return context.finishRecording();
    case "click": {
      let point: { x: number; y: number };
      if (command.ref !== undefined) {
        if (command.x !== undefined || command.y !== undefined)
          throw new BrowserActionError("invalid_arguments");
        const dispatch = context.refDispatch(command.ref, actor, signal, generation);
        // Only where the element itself would take the click, once it holds still.
        point = (await context.refs.target(command.ref, dispatch.prepare)).point;
        dispatch.send();
      } else {
        if (command.x === undefined || command.y === undefined)
          throw new BrowserActionError("invalid_arguments");
        context.check(actor, signal, generation);
        point = { x: command.x, y: command.y };
      }
      context.point?.(point);
      await context.cursor?.point(point, true);
      context.beforeInput?.();
      await clickAt(page, point, command);
      return { ok: true };
    }
    case "fill_form": {
      // Each field is its own type step: a stale ref stops the form where it went stale.
      let kept = false;
      for (const field of command.fields) {
        kept = (await typeInto(context, field.ref, field.value, actor, signal, generation)) || kept;
      }
      return { ok: true, filled: command.fields.length, ...(kept ? keptText : {}) };
    }
    case "pdf": {
      context.read();
      const pdf = await printPdf(page, dir, id(), command);
      context.read();
      if (actor.kind === "human") await context.options.artifact(pdf);
      return pdf;
    }
    case "type":
      return (await typeInto(context, command.ref, command.text, actor, signal, generation))
        ? { ok: true, ...keptText }
        : { ok: true };
    case "press": {
      const dispatch = command.ref
        ? context.refDispatch(command.ref, actor, signal, generation)
        : {
            prepare: () => context.check(actor, signal, generation),
            send: () => context.check(actor, signal, generation),
          };
      if (command.ref) await context.refs.focus(command.ref, dispatch.prepare);
      dispatch.send();
      context.beforeInput?.();
      await page.press(command.key);
      return { ok: true };
    }
    case "scroll":
      context.check(actor, signal, generation);
      context.cursor?.scroll(command.x, command.y);
      context.beforeInput?.();
      await page.wheel(command.x, command.y);
      return { ok: true };
    case "wait_for":
      return waitForBrowser({
        command,
        page,
        refs: context.refs,
        clock: context.options.navigationClock,
        policies: context.policies,
        human: actor.kind === "human",
        signal,
        currentUrl: () => page.url(),
        checkNavigation: () => {
          const blocked = context.blocked();
          if (blocked)
            throw new BrowserOriginError(
              blocked.origin,
              blocked.reason,
              "Browser navigation blocked while waiting",
            );
        },
      });
    case "screenshot": {
      if (command.sizes) {
        if (command.ref) throw new BrowserActionError("invalid_arguments");
        return screenshotAtSizes(command.sizes, command.fullPage, actor, context);
      }
      const path = join(dir, `${id()}.png`);
      const region = await screenshotRegion(command, context.refs, context.read);
      const bytes = await context.capture(() => pngScreenshot(page, region));
      context.read();
      await writeFile(path, bytes, { mode: 0o600 });
      // A person's capture is kept like a recording; agents read theirs as tool images.
      if (actor.kind === "human") {
        await context.options.artifact({ path, mimeType: "image/png", bytes: bytes.byteLength });
        // Small enough to send back, the picture comes too, so the person can copy it.
        if (bytes.byteLength <= inlineScreenshotBytes)
          return { path, mimeType: "image/png", data: bytes.toString("base64") };
      }
      return { path, mimeType: "image/png" };
    }
    case "logs":
      await context.logs.flush();
      return context.logs.read(command);
    case "resize": {
      const before = context.view.emulation;
      await resizePage(command, actor, page, context.view, () =>
        context.check(actor, signal, generation),
      );
      if (before !== context.view.emulation) context.emit();
      return { ok: true };
    }
    case "emulate":
      await emulateDevice(command, actor, page, context.view, () =>
        context.check(actor, signal, generation),
      );
      context.emit();
      return { ok: true };
    case "context_target":
    case "image_data":
      return executeContextCommand(command, actor, page, context.read);
    case "zoom":
    case "clear_data":
    case "page_source":
      return executePageTool(command, actor, page, context.view, {
        check: () => context.check(actor, signal, generation),
        read: context.read,
        changed: () => context.emit(),
      });
    case "evaluate": {
      const document = context.refs.documentGuard();
      if (
        evaluatePolicy &&
        !(await evaluatePolicy(threadId, page.url(), command.mode, command.expression, signal))
      )
        throw new BrowserActionError("evaluate_approval_required");
      context.check(actor, signal, generation);
      document();
      // The person's own browser keeps its cookies and storage from agents unless they allow it.
      if (
        actor.kind === "agent" &&
        context.options.backendKind === "user" &&
        !(await context.options.storageReads?.())
      )
        return evaluateWithoutStorage(cdp, command.expression, command.mode, () => {
          context.check(actor, signal, generation);
          document();
        });
      return command.mode === "read-only"
        ? evaluateReadOnly(cdp, command.expression, () => {
            context.check(actor, signal, generation);
            document();
          })
        : evaluatePage(cdp, command.expression);
    }
  }
}

/**
 * Types into one field. While the person works in the tab, the field's text is kept and the
 * person's focus and caret come back; otherwise the agent's text replaces the field's.
 * Returns whether the field's text was kept.
 */
async function typeInto(
  context: CommandContext,
  ref: string,
  text: string,
  actor: Actor,
  signal: AbortSignal | undefined,
  generation: number,
): Promise<boolean> {
  const dispatch = context.refDispatch(ref, actor, signal, generation);
  // The agent's cursor goes to the field first, so the text appears under it.
  if (context.cursor) await context.cursor.typing(await context.refs.bounds(ref, dispatch.prepare));
  if (actor.kind === "agent" && context.personPresent?.()) {
    dispatch.send();
    context.beforeInput?.();
    return context.refs.typeKeeping(ref, text, dispatch.send);
  }
  await context.refs.select(ref, dispatch.prepare);
  dispatch.send();
  context.beforeInput?.();
  await context.page.insertText(text);
  return false;
}

/**
 * The page at each responsive size, one image each. A person's captures are also kept at full
 * resolution as thread artifacts; an agent gets the images only.
 */
async function screenshotAtSizes(
  sizes: NonNullable<Extract<TabCommand, { action: "screenshot" }>["sizes"]>,
  fullPage: boolean,
  actor: Actor,
  context: CommandContext,
) {
  const human = actor.kind === "human";
  const captures = await captureAtSizes(context.page, sizes, {
    fullPage,
    png: human,
    emulation: context.view.emulation,
    check: () => context.read(),
  });
  context.read();
  const images = [];
  for (const capture of captures) {
    let path: string | undefined;
    if (capture.png) {
      path = join(context.options.dir, `${context.options.id()}-${capture.size}.png`);
      await writeFile(path, capture.png, { mode: 0o600 });
      await context.options.artifact({
        path,
        mimeType: "image/png",
        bytes: capture.png.byteLength,
      });
    }
    images.push({
      size: capture.size,
      width: capture.width,
      height: capture.height,
      mimeType: "image/jpeg" as const,
      data: capture.jpeg.toString("base64"),
      ...(path ? { path } : {}),
    });
  }
  return { images };
}

const modifierBits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
/** A plain left click goes through the backend; other buttons and chords are raw CDP input. */
async function clickAt(
  page: BrowserBackendPage,
  point: { x: number; y: number },
  options: {
    button?: "left" | "middle" | "right";
    clickCount?: number;
    modifiers?: readonly (keyof typeof modifierBits)[];
  },
): Promise<void> {
  const button = options.button ?? "left",
    clickCount = options.clickCount ?? 1,
    modifiers = (options.modifiers ?? []).reduce((bits, name) => bits | modifierBits[name], 0);
  if (button === "left" && clickCount === 1 && modifiers === 0) return page.click(point.x, point.y);
  await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, modifiers });
  for (let count = 1; count <= clickCount; count++)
    for (const type of ["mousePressed", "mouseReleased"])
      await page.cdp.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button,
        clickCount: count,
        modifiers,
      });
}
