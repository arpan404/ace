import { KeyIcon } from "@phosphor-icons/react";
import { Tip } from "@/components/ui/tooltip.tsx";

/** The CLI owns the key; ace shows only the reported sign-in method. */
export function AccountKeyMark(props: { method: string | undefined }) {
  if (props.method !== "api_key") return null;
  return (
    <Tip label="Signed in with an API key">
      <span
        tabIndex={0}
        aria-label="Signed in with an API key"
        className="inline-flex shrink-0 text-muted-foreground"
      >
        <KeyIcon aria-hidden size={12} />
      </span>
    </Tip>
  );
}
