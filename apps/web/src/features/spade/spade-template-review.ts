import type { ShareTemplateReview } from "@ace/protocol/marketplace";

type Extra =
  | "knowledge"
  | "include_heartbeat"
  | "surfaces"
  | "contracts"
  | "plugins"
  | "event_routines";
export type TemplateEdits = Omit<ShareTemplateReview, "visibility" | "acknowledged" | Extra> & {
  [Key in Extra]-?: NonNullable<ShareTemplateReview[Key]>;
};
