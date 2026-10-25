import type { ProviderKind } from "@ace/protocol";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
import { orderedProviders } from "./library-model.ts";

/** Bare agent marks in app order: no tiles, badges or dots. */
export function ProviderMarks(props: {
  providers: readonly ProviderKind[];
  size?: 12 | 14 | 16;
  /** Hide from assistive tech when words beside the marks already name the agents. */
  decorative?: boolean;
  className?: string;
}) {
  const providers = orderedProviders(props.providers);
  if (!providers.length) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-1", props.className)}>
      {providers.map((provider) => (
        <ProviderIcon
          key={provider}
          provider={provider}
          size={props.size ?? 14}
          decorative={props.decorative ?? false}
        />
      ))}
    </span>
  );
}
