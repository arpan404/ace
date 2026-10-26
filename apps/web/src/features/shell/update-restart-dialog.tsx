import { RestartConfirm } from "./restart-confirm.tsx";

/** Asks before restarting into a downloaded update, saying how many agents it stops. */
export function UpdateRestartDialog(props: {
  open: boolean;
  /** Agents on this machine the Restart stops: undefined while counting, null when unknown. */
  busy: number | null | undefined;
  onOpenChange: (open: boolean) => void;
  onInstall: () => void;
}) {
  return (
    <RestartConfirm
      open={props.open}
      title="Restart to update?"
      busy={props.busy}
      onOpenChange={props.onOpenChange}
      onRestart={props.onInstall}
    />
  );
}
