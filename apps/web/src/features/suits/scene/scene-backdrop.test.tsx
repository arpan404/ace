import type { SceneSignal } from "@ace/protocol/suits";
import { act, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { SceneBackdrop, type SceneBackdropProps, type SignalFeed } from "./scene-backdrop.tsx";

const sceneUrl = "http://127.0.0.1:4242/suits/aurora-tide/scene";

function feed() {
  const watchers = new Set<(signal: SceneSignal) => void>();
  const signals: SignalFeed = {
    watch(send) {
      watchers.add(send);
      return () => void watchers.delete(send);
    },
  };
  return { signals, send: (signal: SceneSignal) => watchers.forEach((watcher) => watcher(signal)) };
}

function mount(props: Partial<SceneBackdropProps> = {}) {
  const thread = feed();
  const tree = (more: Partial<SceneBackdropProps>) => (
    <SceneBackdrop
      sceneUrl={sceneUrl}
      scheme="dark"
      reduceMotion={false}
      signals={thread.signals}
      {...props}
      {...more}
    />
  );
  const view = render(tree({}));
  const frame = () => view.container.querySelector("iframe");
  const fromScene = (data: unknown, source: Window | null = frame()?.contentWindow ?? null) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source }));
    });
  /** Loads the scene page and records what the host sends it from then on. */
  const load = () => {
    const target = frame()?.contentWindow;
    const sent: unknown[] = [];
    if (target)
      vi.spyOn(target, "postMessage").mockImplementation((message) => void sent.push(message));
    act(() => {
      frame()?.dispatchEvent(new Event("load"));
    });
    return sent;
  };
  return {
    ...view,
    frame,
    fromScene,
    load,
    signal: thread.send,
    rerenderWith: (more: Partial<SceneBackdropProps>) => view.rerender(tree(more)),
  };
}

test("a Suit without a scene shows no frame", () => {
  expect(mount({ sceneUrl: null }).frame()).toBeNull();
});

test("the scene runs in a scripts-only sandbox that the pointer and screen readers pass over", () => {
  const frame = mount().frame();
  expect(frame?.getAttribute("src")).toBe(sceneUrl);
  expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame?.getAttribute("aria-hidden")).toBe("true");
  expect(frame?.className).toContain("pointer-events-none");
});

test("init waits for the scene page to load, and signals reach a ready scene", () => {
  const scene = mount();
  const sent = scene.load();
  expect(sent[0]).toMatchObject({ type: "init", scheme: "dark", reduceMotion: false });
  scene.fromScene({ type: "ready" });
  act(() => scene.signal("pr-merged"));
  expect(sent).toContainEqual({ type: "signal", signal: "pr-merged" });
});

test("the 3 s to be ready run from the scene page's load, not from its mount", () => {
  vi.useFakeTimers();
  try {
    const onStopped = vi.fn();
    const scene = mount({ onStopped });
    // A slow first load of the app: the page takes its time to arrive.
    act(() => void vi.advanceTimersByTime(5_000));
    expect(onStopped).not.toHaveBeenCalled();
    scene.load();
    act(() => void vi.advanceTimersByTime(2_900));
    expect(onStopped).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(200));
    expect(onStopped).toHaveBeenCalledWith({ reason: "no-ready" }, sceneUrl);
  } finally {
    vi.useRealTimers();
  }
});

test("a scheme change reaches the scene", () => {
  const scene = mount();
  const sent = scene.load();
  scene.fromScene({ type: "ready" });
  scene.rerenderWith({ scheme: "light" });
  expect(sent).toContainEqual({ type: "scheme", scheme: "light" });
});

test("a scene that reports an error is taken down and the failure reported", () => {
  const onStopped = vi.fn();
  const scene = mount({ onStopped });
  scene.fromScene({ type: "error", message: "boom" });
  expect(scene.frame()).toBeNull();
  expect(onStopped).toHaveBeenCalledWith({ reason: "error", message: "boom" }, sceneUrl);
});

test("an error message from anywhere but the scene's frame is ignored", () => {
  const onStopped = vi.fn();
  const scene = mount({ onStopped });
  scene.fromScene({ type: "error", message: "spoofed" }, window);
  expect(scene.frame()).not.toBeNull();
  expect(onStopped).not.toHaveBeenCalled();
});

test("a stopped scene stays down until the Suit's scene changes", () => {
  const scene = mount();
  scene.fromScene({ type: "error", message: "boom" });
  scene.rerenderWith({});
  expect(scene.frame()).toBeNull();
  scene.rerenderWith({ sceneUrl: `${sceneUrl}?v=2` });
  expect(scene.frame()).not.toBeNull();
});

const rect = (x: number, y: number, width: number, height: number) =>
  DOMRect.fromRect({ x, y, width, height });
/** Past the next animation frame, where the host measures its glass. */
const nextFrame = () => act(() => new Promise((resolve) => setTimeout(resolve, 40)));
const isGlass = (message: unknown) => (message as { type?: string }).type === "glass";

test("the app's scene is told where ace's glass sits over it, and told again when a menu opens", async () => {
  const boxes = new Map<Element | null, DOMRect>();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return boxes.get(this) ?? rect(0, 0, 0, 0);
  });
  document.documentElement.style.setProperty("--glass-blur", "20px");
  const sidebar = document.createElement("aside");
  sidebar.dataset["part"] = "sidebar";
  sidebar.style.borderTopLeftRadius = "12px";
  document.body.append(sidebar);
  try {
    const scene = mount();
    boxes.set(scene.frame(), rect(0, 0, 1440, 900));
    boxes.set(sidebar, rect(8, 40, 300, 852));
    const sent = scene.load();
    await nextFrame();
    expect(sent.findLast(isGlass)).toEqual({
      type: "glass",
      rects: [{ x: 8, y: 40, width: 300, height: 852, radius: 12, blur: 20, saturate: 1 }],
    });

    // A menu portals into <body>, over the scene.
    const menu = document.createElement("div");
    menu.className = "ace-floating";
    boxes.set(menu, rect(600, 100, 240, 320));
    document.body.append(menu);
    await nextFrame();
    expect(sent.findLast(isGlass)).toMatchObject({
      rects: [
        { x: 8, width: 300 },
        { x: 600, y: 100, width: 240, height: 320 },
      ],
    });
    menu.remove();
  } finally {
    sidebar.remove();
    document.documentElement.style.removeProperty("--glass-blur");
    vi.restoreAllMocks();
  }
});
