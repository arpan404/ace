import type { BrowserAnnotationEvent } from "@ace/protocol";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { copyImageToClipboard } from "@/lib/clipboard-image.ts";
import { captureFile } from "./capture-file.ts";
import type { AnnotationDriver } from "./driver.ts";
import { composerPorts, sessionPorts } from "./store.ts";

/** How long the page settles after a change before its screenshot is taken again. */
const pageSettleMs = 400;

/** The page as annotate mode needs to know it. */
export interface AnnotatablePage {
  url: string;
  closed: boolean;
  status?: "ready" | "paused" | "recovering" | undefined;
  features?: readonly string[] | undefined;
}

/** Why the person can't annotate this page now, in words for the button's tooltip. */
export function annotateUnavailable(input: {
  driver: AnnotationDriver | undefined;
  online: boolean;
  /** The page this tab shows, once it is bound and loaded. */
  page: AnnotatablePage | undefined;
}): string | undefined {
  if (!input.online) return "ace is offline";
  const page = input.page;
  if (!page || page.closed) return "Open a page to annotate it";
  if (!input.driver || !page.features?.includes("annotate"))
    return "This daemon can't annotate pages. Update ace to use it.";
  if (page.status === "paused") return "The browser is paused";
  if (page.status === "recovering") return "The browser is reopening the page";
  if (!/^https?:\/\//i.test(page.url)) return "Only web pages can be annotated";
  return undefined;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : "ace refused it");
const theme = (): "light" | "dark" =>
  document.documentElement.dataset["scheme"] === "light" ? "light" : "dark";

/**
 * Annotate mode for a thread's page (ADR 0082). Turning it on takes a temporary control hold
 * and starts the overlay; every pinned comment goes into the thread composer's draft with its
 * element crop, and the page's screenshot follows once the page settles. The bar's Send sends
 * the composer's message, its screenshot button copies the page, and leaving the mode (✕,
 * Send, the toggle, a navigation, losing control) hands the page back.
 */
export function useAnnotate(options: {
  threadId: string;
  driver: AnnotationDriver | undefined;
  temporaryControl(threadId: string): { ready: Promise<void>; release(): Promise<void> };
  /** The page shown now; `unavailable` says why annotating can't start. */
  url: string | undefined;
  unavailable: string | undefined;
}) {
  const { threadId, driver } = options;
  const toast = useToast();
  const [mode, setMode] = useState<"off" | "starting" | "on">("off");
  const session = useRef<{
    hold?: { release(): Promise<void> } | undefined;
    url?: string | undefined;
    timer?: ReturnType<typeof setTimeout> | undefined;
    capture?: Promise<void> | undefined;
    bar?: { x: number; y: number } | undefined;
    edit?: string | undefined;
    live: boolean;
  }>({ live: false });

  const finish = () => {
    const current = session.current;
    clearTimeout(current.timer);
    const hold = current.hold;
    session.current = { live: false, bar: current.bar };
    setMode("off");
    void hold
      ?.release()
      .catch((error: unknown) =>
        toast.error({ title: "Couldn't hand back the page", description: reason(error) }),
      );
  };
  const command = (input: Parameters<AnnotationDriver["command"]>[1]) =>
    driver?.command(threadId, input).catch(() => {});

  const capturePage = () => {
    const current = session.current;
    clearTimeout(current.timer);
    current.timer = undefined;
    const url = current.url;
    const port = composerPorts.get(threadId);
    if (!driver || !current.live || !url || !port) return;
    const numbers = port
      .annotations()
      .filter((annotation) => annotation.url === url)
      .map((annotation) => annotation.number);
    if (!numbers.length) return;
    current.capture = driver.capture(threadId, { kind: "page" }).then(
      (capture) => port.page(url, captureFile(capture, `annotated-page-${Math.min(...numbers)}`)),
      () => {},
    );
  };
  const schedulePage = () => {
    clearTimeout(session.current.timer);
    session.current.timer = setTimeout(capturePage, pageSettleMs);
  };
  /** Take the page's screenshot now if a change is waiting for it. */
  const flushPage = async () => {
    if (session.current.timer !== undefined) capturePage();
    await session.current.capture;
  };

  const screenshot = () => {
    if (!driver) return;
    const image = driver
      .capture(threadId, { kind: "page" })
      .then((capture) => captureFile(capture, "page"));
    copyImageToClipboard(image).then(
      () => command({ op: "toast", text: "Screenshot saved to clipboard" }),
      () => command({ op: "toast", text: "Couldn't copy the screenshot" }),
    );
  };

  const start = async () => {
    if (!driver || session.current.hold) return;
    setMode("starting");
    const hold = options.temporaryControl(threadId);
    session.current.hold = hold;
    try {
      await hold.ready;
      const numbers =
        composerPorts
          .get(threadId)
          ?.annotations()
          .map((item) => item.number) ?? [];
      const bar = session.current.bar;
      await driver.start(threadId, {
        theme: theme(),
        nextNumber: Math.min(99, Math.max(0, ...numbers) + 1),
        ...(bar ? { bar } : {}),
      });
    } catch (error) {
      if (session.current.hold !== hold) return;
      toast.error({ title: "Couldn't start annotating", description: reason(error) });
      finish();
    }
  };
  const stop = async () => {
    if (!session.current.hold) return;
    await driver?.stop(threadId).catch(() => {});
    if (session.current.hold) finish();
  };

  const onEvent = useEffectEvent((event: BrowserAnnotationEvent) => {
    const port = composerPorts.get(threadId);
    switch (event.kind) {
      case "ready": {
        session.current.live = true;
        session.current.url = event.url;
        setMode("on");
        const shown = port?.annotations().filter((annotation) => annotation.url === event.url);
        if (shown?.length) void command({ op: "restore", annotations: [...shown] });
        const edit = session.current.edit;
        session.current.edit = undefined;
        if (edit) void command({ op: "edit", id: edit });
        return;
      }
      case "saved": {
        if (!port || !driver) return;
        const { annotation } = event;
        const known = port.annotations().some((existing) => existing.id === annotation.id);
        if (known) return port.save(annotation);
        port.save(
          annotation,
          driver.capture(threadId, { kind: "annotation", id: annotation.id }).then(
            (capture) => captureFile(capture, `annotation-${annotation.number}`),
            () => undefined,
          ),
        );
        schedulePage();
        return;
      }
      case "removed":
        port?.remove(event.id);
        schedulePage();
        return;
      case "discard":
        port?.clear();
        return;
      case "screenshot":
        screenshot();
        return;
      case "send":
        void flushPage().then(() => {
          composerPorts.get(threadId)?.submit();
          void stop();
        });
        return;
      case "bar":
        session.current.bar = { x: event.x, y: event.y };
        return;
      case "close":
      case "ended":
        if (session.current.hold || session.current.live) finish();
        return;
    }
  });
  useEffect(() => driver?.events(threadId, onEvent), [driver, threadId]);

  // Read while the composer renders its list, so kept in a ref rather than an effect event.
  const shown = useRef({ url: options.url, startable: !options.unavailable });
  useLayoutEffect(() => {
    shown.current = { url: options.url, startable: !options.unavailable };
  });
  const port = useEffectEvent((action: "edit" | "remove" | "clear", id?: string) => {
    const live = session.current.live;
    if (action === "edit" && id) {
      if (live) return void command({ op: "edit", id });
      if (!shown.current.startable) return;
      session.current.edit = id;
      return void start();
    }
    if (!live) return;
    if (action === "remove" && id) void command({ op: "remove", id });
    if (action === "clear") void command({ op: "clear" });
    schedulePage();
  });
  useEffect(() => {
    if (!driver) return;
    return sessionPorts.register(threadId, {
      url: () => shown.current.url,
      edit: (id) => port("edit", id),
      remove: (id) => port("remove", id),
      clear: () => port("clear"),
    });
  }, [driver, threadId]);

  // Leaving the tab leaves annotate mode and hands the page back.
  const end = useEffectEvent(finish);
  useEffect(
    () => () => {
      if (!session.current.hold) return;
      void driver?.stop(threadId).catch(() => {});
      end();
    },
    [driver, threadId],
  );

  return {
    mode,
    toggle: () => void (mode === "off" ? start() : stop()),
  };
}
