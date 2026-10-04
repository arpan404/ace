import { deferredComponent } from "@/lib/deferred-component.tsx";

/*
 * The composer's menus only render once opened. Their code shares one chunk that loads after the
 * thread has painted, warmed while idle (`preloadComposerParts`), inside the ADR 0056 budgets.
 */
const menus = () => import("./composer-menus.tsx");

export const DeferredPermissionMenu = deferredComponent(() =>
  menus().then((module) => module.PermissionMenu),
);
export const DeferredAddMenu = deferredComponent(() => menus().then((module) => module.AddMenu));

export function preloadComposerMenus(): Promise<unknown> {
  return Promise.all([DeferredPermissionMenu.preload(), DeferredAddMenu.preload()]);
}

/** A menu whose code is still on its way: one quiet row, the menu's own size. */
export function MenuPending() {
  return (
    <p role="status" className="flex h-8 items-center px-2.5 text-xs text-subtle-foreground">
      Loading…
    </p>
  );
}
