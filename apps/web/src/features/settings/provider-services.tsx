import { Button } from "@/components/ui/button.tsx";
import { useRefreshModels } from "@/features/model-picker/index.ts";
import type { ModelSourceStatus, ProviderKind } from "@ace/protocol";
import { PlusIcon } from "@phosphor-icons/react";
import { ProviderTile, StatusLine } from "@/components/provider-tile.tsx";
import { SettingSection } from "@/components/setting-row.tsx";
import { useModelInstances } from "@/lib/model-catalog.ts";
import { preloadSignIn, SignInButton, useSignIn } from "@/features/sign-in/index.ts";

/**
 * The services OpenCode or Pi reaches models through (OpenCode Go and Zen, GitHub Copilot, the
 * person's API-key providers), as the model catalog last found them: one row each with where it
 * stands, Reconnect on one that fails and Disconnect on one that works, then Connect a service.
 * Local runtimes need no sign-in; they're named in a line under the rows.
 */
export function ProviderServices(props: { provider: ProviderKind; name: string }) {
  const signIn = useSignIn();
  const refresh = useRefreshModels();
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
      <ul aria-label={`${props.name} services`} className="divide-y">
        {listed.map(({ source, error }) => (
          <li key={source.id} className="flex h-9 items-center gap-2">
            <ProviderTile
              provider={props.provider}
              service={source}
              size="sm"
              className="size-5 rounded-none bg-transparent shadow-none"
            />
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="truncate font-medium">{source.label}</span>
              {error && (
                <StatusLine
                  tone={error.code === "no_models" ? "idle" : "problem"}
                  text={error.code === "no_models" ? "No models enabled" : "Needs attention"}
                />
              )}
            </div>
            {error?.code === "no_models" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={refresh.pending || Boolean(refresh.reason)}
                onClick={() => refresh.refresh(props.provider)}
              >
                Refresh
              </Button>
            ) : error ? (
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
              className="flex min-h-9 w-full items-center gap-2 py-1 text-left text-muted-foreground focus-ring hover:text-foreground"
            >
              <span className="grid size-5 place-items-center">
                <PlusIcon aria-hidden size={14} />
              </span>
              <span className="font-medium">Connect a service</span>
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
