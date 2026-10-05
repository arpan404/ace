import { GitBranchIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useId, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { DialogClose, DialogFooter } from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";

/** A labelled text field with its live problem under it. */
export function TextField(props: {
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  /** Shown once the person has typed or tried to submit. */
  problem: string | undefined;
  showProblem: boolean;
  mono?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  hint?: ReactNode;
}) {
  const id = useId();
  const messageId = useId();
  const visible = props.showProblem ? props.problem : undefined;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-muted-foreground">
        {props.label}
      </label>
      <Input
        id={id}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        spellCheck={false}
        autoComplete="off"
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        aria-invalid={visible ? true : undefined}
        aria-describedby={visible || props.hint ? messageId : undefined}
        className={props.mono ? "font-mono text-[12.5px]" : undefined}
      />
      {(visible || props.hint) && (
        <p
          id={messageId}
          className={visible ? "text-sm text-destructive" : "text-sm text-subtle-foreground"}
        >
          {visible ?? props.hint}
        </p>
      )}
    </div>
  );
}

/** Why the daemon said no, beside what it refused. */
export function Problem(props: { children: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md bg-secondary px-3 py-2 text-ui">
      <Icon icon={WarningCircleIcon} className="mt-px text-status-failed" />
      <div className="min-w-0 flex-1 text-foreground">{props.children}</div>
      {props.action}
    </div>
  );
}

/** A choice the person may want instead (the repository around a folder). Not an error. */
export function Offer(props: { children: ReactNode; action: ReactNode }) {
  return (
    <div role="note" className="flex items-start gap-2 rounded-md bg-secondary px-3 py-2 text-ui">
      <Icon icon={GitBranchIcon} className="mt-px text-muted-foreground" />
      <p className="min-w-0 flex-1 text-foreground">{props.children}</p>
      {props.action}
    </div>
  );
}

/** Cancel and the tab's one primary action. */
export function Footer(props: { children: ReactNode; note?: ReactNode; closeLabel?: string }) {
  return (
    <DialogFooter className="items-center">
      {props.note && (
        <div className="mr-auto flex min-w-0 flex-1 text-sm text-subtle-foreground">
          {props.note}
        </div>
      )}
      <DialogClose render={<Button variant="ghost">{props.closeLabel ?? "Cancel"}</Button>} />
      {props.children}
    </DialogFooter>
  );
}
