import { HandIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { keymap } from "@/lib/keymap.ts";

/**
 * Take control ⌃⇧C / Hand back: the one switch between watching an agent drive a screen (a
 * browser, a device) and driving it yourself. The caller binds `keymap.takeControl`.
 */
export function ControlToggle(props: { inControl: boolean; disabled?: boolean; onToggle(): void }) {
  return (
    <Button
      size="sm"
      variant={props.inControl ? "secondary" : "primary"}
      disabled={props.disabled}
      onClick={props.onToggle}
      className="rounded-full"
    >
      {!props.inControl && <HandIcon aria-hidden size={14} />}
      {props.inControl ? "Hand back" : "Take control"}
      <Kbd
        aria-hidden
        keys={keymap.takeControl.keys}
        className="ml-0.5 bg-[rgb(255_255_255/0.18)] text-current"
      />
    </Button>
  );
}
