import { memo, type ReactNode, type Ref } from "react";
import { AddButton, type AddHandle } from "./add-button.tsx";
import { PrimaryAction, StopAction, type PrimaryMode } from "./primary-action.tsx";

/**
 * The composer's action row: + and approvals on the left, the model, Stop and send on the
 * right, in Tab order. Memoised on props that change only when the draft empties or fills, so
 * typing never re-renders the controls.
 */
export const ComposerFooter = memo(function ComposerFooter(props: {
  addMenu: Ref<AddHandle>;
  onFiles(files: FileList): void;
  onAddOpen(): void;
  unavailable?: { reason: string; describedBy: string } | undefined;
  /** The one-row pill: only +, the model and send show. */
  pill: boolean;
  controls?: ReactNode;
  trailing?: ReactNode;
  mode: PrimaryMode;
  blocked: string | undefined;
  off: boolean;
  canSteer: boolean;
  describedBy: string | undefined;
  /** The agent works and can be stopped: Stop shows beside send, draft or not. */
  canStop: boolean;
  stopping: boolean;
  onSend(): void;
  onStop(): void;
  onFocusInput(): void;
}) {
  return (
    // Clicking the footer's empty space writes in the message, as the input's own area does.
    <div
      data-slot="composer-footer"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        props.onFocusInput();
      }}
      className="mb-1.5 flex h-11 min-w-0 items-center justify-between gap-0.5 px-2"
    >
      <div data-slot="composer-add" className="flex shrink-0 items-center">
        <AddButton
          handle={props.addMenu}
          onFiles={props.onFiles}
          onOpen={props.onAddOpen}
          unavailable={props.unavailable}
        />
      </div>
      {/* The pill keeps only +, the model and send: these wait until it opens. */}
      <div
        data-slot="composer-controls"
        hidden={props.pill}
        className="flex flex-1 items-center gap-0.5"
      >
        {props.controls}
      </div>
      <div data-slot="composer-trailing" className="flex min-w-0 shrink items-center">
        {props.trailing}
      </div>
      <div data-slot="composer-primary" className="flex shrink-0 items-center gap-1">
        {props.canStop && <StopAction stopping={props.stopping} onStop={props.onStop} />}
        <PrimaryAction
          mode={props.mode}
          blocked={props.blocked}
          off={props.off}
          canSteer={props.canSteer}
          describedBy={props.describedBy}
          onSend={props.onSend}
        />
      </div>
    </div>
  );
});
