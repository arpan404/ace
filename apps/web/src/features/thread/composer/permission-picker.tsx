import type { PermissionOption } from "@ace/ui-core";
import { Suspense } from "react";
import { Dot } from "@/components/ui/dot.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { iconControl } from "./composer-styles.ts";
import { DeferredPermissionMenu, MenuPending } from "./deferred-menus.tsx";
import { riskIcons } from "./permission-icons.ts";
import type { PermissionMenuView } from "./permission-view.ts";

export type { PermissionMenuView } from "./permission-view.ts";

/** "Applies at the agent's next turn" read on after the mode's name: "applies at…". */
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * How the agent's actions get approved, as one icon in the composer: a shield whose glyph
 * follows the mode's risk, drawn in the attention colour when nothing is gated. Its name and
 * what it gates are in the tooltip and the accessible name; the menu lists the provider's modes
 * (any `{id, label, description, risk}` list, ace's or a provider's own). While a change waits
 * for the agent's next turn a small mark sits on the icon and the tooltip says when it applies;
 * a mode that couldn't be honoured as asked (`fallback`) puts a warning mark there.
 */
export function PermissionPicker(props: {
  /** The mode in effect. */
  current: PermissionOption | undefined;
  /** The mode chosen to replace it, not in effect yet. */
  next?: PermissionOption | undefined;
  /** When `next` applies: "Applies at the agent's next turn", "Will apply when reconnected". */
  note?: string | undefined;
  /** What the mode in effect gates, for the tooltip: "Protected reads not gated". */
  detail?: string | undefined;
  /** The mode comes from the default. */
  inherited?: boolean | undefined;
  menu: PermissionMenuView;
  onChange(id: string | null): void;
}) {
  const { current, next, menu } = props;
  const label = current?.label ?? (menu.loading ? "Approvals…" : "Approvals");
  const Glyph = riskIcons[current?.risk ?? "medium"];
  const attention = current?.risk === "high";
  const waits = next && props.note ? `${next.label} ${lower(props.note)}` : undefined;
  const tip = [
    current ? `Approvals: ${label}` : label,
    props.detail,
    menu.fallback,
    waits,
    props.inherited ? "default" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Menu>
      <Tip label={menu.unavailable ?? tip} side="top">
        <MenuTrigger
          aria-label={`Approvals: ${label}${waits ? `, ${waits}` : ""}`}
          aria-description={menu.fallback}
          // Nothing gated reads in the attention colour: a quiet, constant warning.
          className={cn(
            iconControl,
            "relative",
            attention &&
              "text-status-needs-you hover:text-status-needs-you aria-expanded:text-status-needs-you",
          )}
        >
          <Glyph aria-hidden size={16} weight={attention ? "fill" : "regular"} />
          {(next || menu.fallback) && (
            <Dot
              tone={menu.fallback ? "needs-you" : "working"}
              className="absolute top-1.5 right-1.5"
            />
          )}
        </MenuTrigger>
      </Tip>
      <MenuContent
        side="top"
        align="start"
        className="max-h-[var(--available-height)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <Suspense fallback={<MenuPending />}>
          <DeferredPermissionMenu.Component view={menu} onChange={props.onChange} />
        </Suspense>
      </MenuContent>
    </Menu>
  );
}
