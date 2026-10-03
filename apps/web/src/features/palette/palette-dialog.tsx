import { CommandDialog } from "@/components/ui/command.tsx";
import PaletteBody from "./palette-body.tsx";

/** The ⌘K sheet and its commands, as one lazily loaded chunk. */
export default function PaletteDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  close(): void;
}) {
  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open && <PaletteBody close={props.close} />}
    </CommandDialog>
  );
}
