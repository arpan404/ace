import type { ReadinessTone } from "@ace/ui-core";
import type { ReactNode } from "react";
import { SettingListItem } from "@/components/setting-row.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { part, type SuitPartState } from "@/lib/suit-part.ts";

/** An account row's `data-state` for Suits: waiting when it needs the person, failed on a problem. */
const rowState = {
  ready: undefined,
  action: "waiting",
  problem: "failed",
  idle: "disabled",
} as const satisfies Record<ReadinessTone, SuitPartState | undefined>;

/** A status in its tone's colour, words only: an account's sub line. */
const toneOf = { ready: "done", action: "needs-you", problem: "failed", idle: "idle" } as const;

/**
 * One account on a provider's Accounts list, for ace's providers and Spade's alike: its badge,
 * its name (with a tooltip, for a long one) and the marks after it, the line under it, and at
 * the right its usage and actions, which wrap under the name on a narrow screen. `children` are
 * the dialogs the row opens.
 */
export function AccountRowFrame(props: {
  /** The row's id: a link to `#account-<id>` scrolls to it and flashes it. */
  id: string;
  tone: ReadinessTone;
  badge: ReactNode;
  label: string;
  /** After the name: how it signs in, Default, which sign-in. */
  marks?: ReactNode;
  /** The line under the name; nothing when it has nothing to say. */
  sub?: ReactNode;
  right: ReactNode;
  children?: ReactNode;
}) {
  return (
    <SettingListItem
      id={`account-${props.id}`}
      tabIndex={-1}
      {...part("list-row", rowState[props.tone], "account")}
      className="flex-wrap gap-x-3 gap-y-2 py-2 focus-ring-inset"
    >
      {props.badge}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <Tip label={props.label}>
            {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so its tooltip reaches the keyboard */}
            <span tabIndex={0} className="truncate rounded-xs font-medium focus-ring">
              {props.label}
            </span>
          </Tip>
          {props.marks}
        </span>
        {props.sub && (
          <span className="flex min-w-0 items-baseline gap-1 text-xs text-subtle-foreground">
            {props.sub}
          </span>
        )}
      </div>
      {/* On a narrow screen the usage and actions wrap under the name. */}
      <div className="ml-auto flex items-center justify-end gap-2 @max-[34rem]:w-full @max-[34rem]:pl-8">
        {props.right}
      </div>
      {props.children}
    </SettingListItem>
  );
}

/** An account's state in words, in its tone's colour unless it is ready. */
export function AccountStateWords(props: { tone: ReadinessTone; children: ReactNode }) {
  return (
    <span
      data-tone={toneOf[props.tone]}
      className={cn("shrink-0", props.tone !== "ready" && "text-(--tone-text)")}
    >
      {props.children}
    </span>
  );
}
