import { isKeymapId } from "@/lib/keymap.ts";

/** The preload validates IPC; accept only actions in this renderer's keymap. */
export function syncDesktopKeymap(
  bindings: Readonly<Record<string, string>>,
  scope: object = globalThis,
): (() => void) | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  if (typeof ace !== "object" || ace === null) return;
  const bridge: unknown = Reflect.get(ace, "keymap");
  if (typeof bridge !== "object" || bridge === null) return;
  const update: unknown = Reflect.get(bridge, "update");
  const onAction: unknown = Reflect.get(bridge, "onAction");
  if (typeof update !== "function" || typeof onAction !== "function") return;
  void Promise.resolve(Reflect.apply(update, bridge, [bindings])).catch(() => {});
  const stop: unknown = Reflect.apply(onAction, bridge, [
    (id: unknown) => {
      if (typeof id === "string" && isKeymapId(id))
        window.dispatchEvent(new CustomEvent("ace:keymap", { detail: id, cancelable: true }));
    },
  ]);
  return () => {
    if (typeof stop === "function") stop();
  };
}
