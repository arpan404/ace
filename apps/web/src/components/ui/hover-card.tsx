import { PreviewCard } from "@base-ui/react/preview-card";

/**
 * A details card on hover: its root and trigger. The card's popup is in `hover-card-content.tsx`,
 * so a row that only opens one on hover can load the popup's code later.
 */
const HoverCard = PreviewCard.Root;
const HoverCardTrigger = PreviewCard.Trigger;

export { HoverCard, HoverCardTrigger };
