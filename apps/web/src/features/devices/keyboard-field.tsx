import type { DeviceInput } from "@ace/protocol";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

/**
 * The compact field the Keyboard button opens over the stage: Enter types the text on the
 * device and keeps the field for more; Escape closes it.
 */
export function KeyboardField(props: { onInput(input: DeviceInput): void; onClose(): void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="ace-floating flex w-full max-w-80 items-center gap-1 rounded-lg p-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (!text) return;
        props.onInput({ kind: "type", text });
        setText("");
      }}
    >
      <Input
        // The person opened it to type: focus follows.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        aria-label="Type on the device"
        placeholder="Type on the device"
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          props.onClose();
        }}
        className="h-8 min-w-0 flex-1"
      />
      <Button type="submit" size="sm" variant="ghost" disabled={!text}>
        Send
      </Button>
    </form>
  );
}
