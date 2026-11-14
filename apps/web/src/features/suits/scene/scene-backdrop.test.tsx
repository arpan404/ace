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
