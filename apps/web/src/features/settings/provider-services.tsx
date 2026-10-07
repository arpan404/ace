import type { ModelSourceStatus, ProviderKind } from "@ace/protocol";
import { serviceKind } from "@ace/ui-core";
import { PlusIcon } from "@phosphor-icons/react";
import { ProviderTile, StatusLine } from "@/components/provider-tile.tsx";
import { SettingSection } from "@/components/setting-row.tsx";
import { useModelInstances } from "@/lib/model-catalog.ts";
import { preloadSignIn, SignInButton, useSignIn } from "@/features/sign-in/index.ts";

/**
 * The services OpenCode or Pi reaches models through (OpenCode Go and Zen, GitHub Copilot, the
 * person's API-key providers), as the model catalog last found them: one card each with where it
 * stands, Reconnect on one that fails and Disconnect on one that works, then Connect a service.
 * Local runtimes need no sign-in; they're named in a line under the cards.
 */
export function ProviderServices(props: { provider: ProviderKind; name: string }) {
  const signIn = useSignIn();
  const instances = useModelInstances();
  const sources = new Map<string, ModelSourceStatus>();
  const local = new Set<string>();
  for (const status of instances) {
    if (status.provider !== props.provider) continue;
    for (const entry of status.sources ?? []) {
      if (entry.source.kind === "account") continue;
      if (entry.source.kind === "local") {
        local.add(entry.source.label);
        continue;
      }
      const known = sources.get(entry.source.id);
      if (!known || (!known.error && entry.error)) sources.set(entry.source.id, entry);
    }
  }
  const listed = [...sources.values()];
  return (
    <SettingSection label="Services">
      <ul aria-label={`${props.name} services`} className="grid gap-2 sm:grid-cols-2">
        {listed.map(({ source, error }) => (
          <li
            key={source.id}
            className="flex min-h-16 items-center gap-3 rounded-card border bg-card px-3.5 py-3"
          >
            <ProviderTile provider={props.provider} service={source} size="sm" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-medium">{source.label}</span>
              <span className="text-sm text-muted-foreground">
                <StatusLine
                  tone={error ? "problem" : "ready"}
                  text={
                    error
                      ? error.message
                      : source.requiresAuth === false
                        ? "Free models available"
                        : ["Connected", serviceKind(source.kind)].filter(Boolean).join(" · ")
                  }
                />
              </span>
            </div>
            {error ? (
              <SignInButton
                label={`Reconnect ${source.label}`}
                target={{ provider: props.provider, choice: source.id, service: source.label }}
              >
                Reconnect
              </SignInButton>
            ) : source.requiresAuth !== false ? (
              <SignInButton
                variant="ghost"
                label={`Disconnect ${source.label}`}
                target={{
                  provider: props.provider,
                  choice: source.id,
                  service: source.label,
                  action: "logout",
                }}
              >
                Disconnect
              </SignInButton>
            ) : null}
          </li>
        ))}
        {signIn && (
          <li>
            <button
              type="button"
              onPointerEnter={() => void preloadSignIn()}
              onClick={() => signIn({ provider: props.provider })}
              className="flex h-full min-h-16 w-full items-center gap-3 rounded-card border border-dashed px-3.5 py-3 text-left text-muted-foreground transition-colors duration-(--dur-1) focus-ring hover:border-solid hover:bg-accent hover:text-foreground"
            >
              <span className="grid size-8 place-items-center rounded-sm bg-secondary">
                <PlusIcon aria-hidden size={14} />
              </span>
              <span className="font-medium">
                {props.provider === "opencode" ? "Sign in for more models" : "Connect a service"}
              </span>
            </button>
          </li>
        )}
      </ul>
      {local.size > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          Also uses models running on this computer: {[...local].join(", ")}.
        </p>
      )}
    </SettingSection>
  );
}
