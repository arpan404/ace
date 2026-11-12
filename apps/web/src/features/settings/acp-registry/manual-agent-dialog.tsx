import { Dialog, DialogContent } from "@/components/ui/dialog.tsx";
import { ManualAgent } from "./manual-agent.tsx";

/** Add an agent by command, in its own dialog. */
export default function ManualAgentDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        {props.open && (
          <ManualAgent
            onCancel={() => props.onOpenChange(false)}
            onAdded={() => props.onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
