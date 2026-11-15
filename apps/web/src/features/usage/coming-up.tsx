import { comingUp, type UsageLimits } from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { BankedResetAction, type RedeemReset } from "./banked-resets.tsx";
import { SectionHeading } from "./usage-parts.tsx";

const plural = (count: number) => `${count} banked reset${count === 1 ? "" : "s"} available`;

/**
 * What changes next across every account, soonest first: a window running out, with when it is
 * back, or one that is out, with when it returns, and the account's banked resets beside it.
 * Nothing at all while every window lasts to its reset.
 */
export function ComingUp(props: { limits: UsageLimits; now: number; redeem?: RedeemReset }) {
  const events = comingUp(props.limits, props.now);
  if (events.length === 0) return null;
  return (
    <>
      <SectionHeading id="usage-coming-up" title="Coming up" />
      <ul aria-labelledby="usage-coming-up" className="flex flex-col text-ui tabular-nums">
        {events.map((event) => (
          <li
            key={event.key}
            className="grid grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-x-4 py-1.5 @min-[40rem]/usage:grid-cols-[5.5rem_minmax(0,1fr)]"
          >
            <span className="whitespace-nowrap text-muted-foreground">{event.time}</span>
            <span className="min-w-0">
              <span className="mr-2 inline-flex align-[-2px]">
                <ProviderIcon
                  provider={event.entry.account.provider}
                  acpAgentId={event.entry.account.acpAgentId}
                  size={14}
                  decorative
                />
              </span>
              {event.what}
              {event.after && (
                <span className="ml-2 whitespace-nowrap text-subtle-foreground">{event.after}</span>
              )}
              {event.banked !== undefined && (
                <span className="mt-0.5 flex gap-2 text-xs text-muted-foreground">
                  {plural(event.banked)}
                  <BankedResetAction entry={event.entry} redeem={props.redeem} />
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
