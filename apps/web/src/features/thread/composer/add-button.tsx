import { PlusIcon } from "@phosphor-icons/react";
import { useImperativeHandle, useRef, type Ref } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
export interface AddHandle {
  open(): void;
  attach(): void;
}
export function AddButton(props: {
  onOpen(): void;
  onFiles(files: FileList): void;
  unavailable?: { reason: string; describedBy: string } | undefined;
  handle?: Ref<AddHandle> | undefined;
}) {
  const files = useRef<HTMLInputElement>(null);
  useImperativeHandle(props.handle, () => ({
    open: props.onOpen,
    attach: () => files.current?.click(),
  }));
  return (
    <>
      <IconButton
        icon={PlusIcon}
        label="Add files and context"
        aria-describedby={props.unavailable?.describedBy}
        disabled={!!props.unavailable}
        reason={props.unavailable?.reason}
        onClick={props.onOpen}
      />
      <input
        ref={files}
        type="file"
        multiple
        hidden
        aria-label="Files to attach"
        onChange={(event) => {
          if (event.target.files?.length) props.onFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </>
  );
}
