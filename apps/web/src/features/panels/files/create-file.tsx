import { FileOperations } from "./file-operations.tsx";

/** The existing version-checked create flow, available to other workspace entry points. */
export function CreateFile(props: {
  threadId: string;
  onClose(): void;
  onCreated(path: string): void;
}) {
  return (
    <FileOperations
      threadId={props.threadId}
      operation={{ kind: "create", folder: "" }}
      onClose={props.onClose}
      onChanged={props.onCreated}
    />
  );
}
