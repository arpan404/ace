import type { ModelSourceStatus, ProviderKind } from "@ace/protocol";
import { useModelInstances } from "@/lib/model-catalog.ts";
import { SignInButton, SignInMenu, useSignIn } from "@/features/sign-in/index.ts";

/**
 * The upstreams OpenCode or Pi reaches models through (OpenCode Go and Zen, GitHub Copilot, the
 * person's API-key providers), as the model catalog last found them, each with its own sign-in:
 * Reconnect on a failing one, and Sign in again in a quiet menu on one that works.
 * Local runtimes need none. "Connect another" starts the CLI's sign-in and lists its choices.
 */
export function UpstreamSources(props: { provider: ProviderKind; name: string }) {
  const signIn = useSignIn();
  const instances = useModelInstances();
  const sources = new Map<string, ModelSourceStatus>();
  for (const status of instances) {
    if (status.provider !== props.provider) continue;
    for (const entry of status.sources ?? []) {
      if (entry.source.kind === "local" || entry.source.kind === "account") continue;
      const known = sources.get(entry.source.id);
      if (!known || (!known.error && entry.error)) sources.set(entry.source.id, entry);
    }
  }
  if (!signIn) return null;
  const listed = [...sources.values()];
  return (
    <div className="pb-3 pl-10 pr-4">
      {listed.length > 0 && (
        <ul aria-label={`${props.name} providers`} className="flex flex-col">
          {listed.map(({ source, error }) => (
            <li key={source.id} className="flex min-h-8 items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                <span className="text-foreground">{source.label}</span>
                <span className="text-muted-foreground">
                  {" · "}
                  {error ? error.message : "Connected"}
                </span>
              </span>
              {error ? (
                <SignInButton
                  label={`Reconnect ${source.label}`}
                  target={{ provider: props.provider, choice: source.id }}
                >
                  Reconnect
                </SignInButton>
              ) : (
                <SignInMenu
                  label={`More for ${source.label}`}
                  items={[
                    {
                      label: "Sign in again",
                      target: { provider: props.provider, choice: source.id },
                    },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <SignInButton variant="link" target={{ provider: props.provider }}>
        Connect another provider to {props.name}
      </SignInButton>
    </div>
  );
}
