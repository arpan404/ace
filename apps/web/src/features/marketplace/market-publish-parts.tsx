import { Fragment, type ReactNode } from "react";
import type { MarketPublishItem } from "./market-publish-port.ts";

/* The publish flow's frame: the steps line, the sticky foot, and an item's entry key. */

export const steps = ["Type", "Item", "Check", "Describe"] as const;
export type Step = (typeof steps)[number] | "done";

export function Steps(props: { now: number }) {
  return (
    <div className="mk-steps" aria-label={`Step ${props.now + 1} of 4`}>
      {steps.map((step, at) => (
        <Fragment key={step}>
          {at > 0 && <i />}
          <span data-step={at < props.now ? "done" : at === props.now ? "now" : undefined}>
            <b>{at + 1}</b>
            <span className="mk-label-word">{step}</span>
          </span>
        </Fragment>
      ))}
    </div>
  );
}

export function Foot(props: { left?: ReactNode; children: ReactNode }) {
  return (
    <div className="mk-foot">
      <div className="mk-foot-inner">
        <span className="mk-grow">{props.left}</span>
        {props.children}
      </div>
    </div>
  );
}

export const keyOf = (item: Pick<MarketPublishItem, "type" | "name">) => ({
  source: "market",
  type: item.type,
  name: item.name,
});
