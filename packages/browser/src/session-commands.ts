import {
  BrowserCommand,
  type BrowserState,
  type BrowserOriginBlock,
  type BrowserArtifact,
} from "@ace/protocol";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { BrowserActionError } from "./action-error.ts";
import { waitForBrowser } from "./wait.ts";
import { BrowserOriginError, browserOrigin } from "./policy.ts";
import { NavigationTask } from "./navigation.ts";
import { evaluatePage, evaluateReadOnly } from "./evaluation.ts";
import { uploadPaths } from "./uploads.ts";
import { dragRefs } from "./drag.ts";
import type { SnapshotRefs } from "./refs.ts";
import type { SessionLogs } from "./logs.ts";
import type { NavigationPolicies } from "./policy-waits.ts";
import type { Actor, SessionOptions } from "./session-options.ts";
interface CommandContext {
  options: SessionOptions;
  refs: SnapshotRefs;
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
  syncTab(): Promise<void>;
  emit(): void;
  run(
    command: BrowserCommand,
    actor: Actor,
    signal: AbortSignal | undefined,
    generation: number,
  ): Promise<unknown>;
  beginRecording(check: () => void): Promise<void>;
  finishRecording(): Promise<BrowserArtifact>;
}
export async function executeBrowserCommand(
  command: BrowserCommand,
  actor: Actor,
  signal: AbortSignal | undefined,
  generation: number,
  context: CommandContext,
): Promise<unknown> {
  const { backend: page, dir, id, evaluatePolicy, threadId } = context.options;
  const cdp = page.cdp;
  switch (command.action) {
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
            "Browser origin requires approval",
          );
        context.check(actor, task.signal, generation);
        await task.run(() => page.navigate(command.url, command.timeout + 65_000, task.signal));
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
      return { tabId: page.tabs?.active(), ...(await context.refs.snapshot()) };
    case "find": {
      const snapshot = await context.refs.snapshot();
      return {
        ...snapshot,
        tabId: page.tabs?.active(),
        nodes: snapshot.nodes.filter(
          (node) =>
            node.role === command.role &&
            (command.exact ? node.name === command.name : node.name.includes(command.name)),
        ),
      };
    }
    case "tabs": {
      const tabs = page.tabs;
      if (!tabs) throw new BrowserActionError("not_supported");
      if (command.operation === "list") return { activeTabId: tabs.active(), tabs: tabs.list() };
      context.check(actor, signal, generation);
      if (command.operation === "open") {
        const tabId = await tabs.open();
        context.check(actor, signal, generation);
        await tabs.switch(tabId);
      } else {
        if (!command.tabId) throw new BrowserActionError("invalid_arguments");
        if (command.operation === "switch") await tabs.switch(command.tabId);
        else await tabs.close(command.tabId);
      }
      await context.syncTab();
      context.check(actor, signal, generation);
      if (command.url)
        await context.run(
          BrowserCommand.parse({ action: "navigate", url: command.url }),
          actor,
          signal,
          generation,
        );
      context.emit();
      return { activeTabId: tabs.active(), tabs: tabs.list() };
    }
    case "dialog":
      context.check(actor, signal, generation);
      if (!page.tabs) throw new BrowserActionError("not_supported");
      await page.tabs.answer(command.dialogId, command.accept, command.promptText);
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
      const rect = await context.refs.bounds(command.ref, dispatch.prepare);
      dispatch.send();
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      });
      return { ok: true };
    }
    case "drag": {
      const from = context.refDispatch(command.ref, actor, signal, generation),
        to = context.refDispatch(command.toRef, actor, signal, generation);
      const start = await context.refs.bounds(command.ref, from.prepare),
        end = await context.refs.bounds(command.toRef, to.prepare);
      await dragRefs(
        cdp,
        { x: start.x + start.width / 2, y: start.y + start.height / 2 },
        { x: end.x + end.width / 2, y: end.y + end.height / 2 },
        () => {
          from.send();
          to.send();
        },
      );
      return { ok: true };
    }
    case "check":
    case "uncheck": {
      const dispatch = context.refDispatch(command.ref, actor, signal, generation);
      const desired = command.action === "check";
      if ((await context.refs.checked(command.ref, dispatch.prepare)) !== desired) {
        const rect = await context.refs.bounds(command.ref, dispatch.prepare);
        dispatch.send();
        await page.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if ((await context.refs.checked(command.ref, dispatch.prepare)) !== desired)
          throw new BrowserActionError("element_unavailable");
      }
      return { ok: true };
    }
    case "network_body":
      if (!page.networkBody) throw new BrowserActionError("not_supported");
      return page.networkBody(command.requestId);
    case "record_start":
      await context.beginRecording(() => context.check(actor, signal, generation));
      return { recording: true };
    case "record_stop":
      return context.finishRecording();
    case "click": {
      const dispatch = context.refDispatch(command.ref, actor, signal, generation);
      const rect = await context.refs.bounds(command.ref, dispatch.prepare);
      dispatch.send();
      if (rect.width <= 0 || rect.height <= 0) throw new BrowserActionError("not_visible");
      await page.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { ok: true };
    }
    case "type": {
      const dispatch = context.refDispatch(command.ref, actor, signal, generation);
      await context.refs.select(command.ref, dispatch.prepare);
      dispatch.send();
      await page.insertText(command.text);
      return { ok: true };
    }
    case "press": {
      const dispatch = command.ref
        ? context.refDispatch(command.ref, actor, signal, generation)
        : {
            prepare: () => context.check(actor, signal, generation),
            send: () => context.check(actor, signal, generation),
          };
      if (command.ref) await context.refs.focus(command.ref, dispatch.prepare);
      dispatch.send();
      await page.press(command.key);
      return { ok: true };
    }
    case "scroll":
      await page.wheel(command.x, command.y);
      return { ok: true };
    case "wait_for":
      return waitForBrowser({
        command,
        cdp,
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
      const path = join(dir, `${id()}.png`);
      const bytes = await page.screenshot("png");
      context.read();
      await writeFile(path, bytes, { mode: 0o600 });
      return { path, mimeType: "image/png" };
    }
    case "logs":
      await context.logs.flush();
      return context.logs.read(command);
    case "resize":
      await page.resize(command.width, command.height);
      return { ok: true };
    case "emulate":
      await page.resize(command.width, command.height);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: command.width,
        height: command.height,
        deviceScaleFactor: command.deviceScaleFactor,
        mobile: command.mobile,
      });
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: command.touch });
      await page.media(command.colorScheme);
      return { ok: true };
    case "evaluate": {
      const document = context.refs.documentGuard();
      if (!(await evaluatePolicy?.(threadId, page.url(), command.mode, command.expression)))
        throw new BrowserActionError("evaluate_approval_required");
      context.check(actor, signal, generation);
      document();
      return command.mode === "read-only"
        ? evaluateReadOnly(cdp, command.expression, () => {
            context.check(actor, signal, generation);
            document();
          })
        : evaluatePage(cdp, command.expression);
    }
  }
}
