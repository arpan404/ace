import { formatAgo } from "@ace/ui-core";
import { menuSeparator } from "@/components/ui/menu-styles.ts";
import { UsageAccounts, useRedeemReset, useUsageHeadroom } from "@/features/usage/index.ts";
import type { DesktopTray } from "@/boot/desktop-tray.ts";
import { TrayCommand } from "./tray-parts.tsx";

/**
 * The Usage tab: the rail's Usage card without its title (the tab names it), its accounts in a
 * list that scrolls when long, then when it was read and the way to the Usage page.
 */
export function TrayUsage(props: { tray: DesktopTray }) {
  const usage = useUsageHeadroom();
  const redeem = useRedeemReset(usage.refresh);
  const read =
    usage.observedAt === undefined
      ? "Not read yet"
      : `Read ${formatAgo(usage.observedAt, usage.now)}`;
  return (
    <>
      <div className="no-scrollbar max-h-[360px] overflow-y-auto overscroll-contain px-2.5 pt-1.5 pb-2">
        <UsageAccounts
          rail={usage.rail}
          now={usage.now}
          redeem={redeem}
          onDialogChange={() => {}}
        />
      </div>
      <div className={menuSeparator} />
      <TrayCommand
        label="Open Usage"
        onClick={() => props.tray.open({ kind: "usage" })}
        end={<span className="pl-3 text-xs text-subtle-foreground">{read}</span>}
      />
    </>
  );
}
