import type { ModelDiscoveryError, ModelSourceStatus, ProviderKind } from "@ace/protocol";
import { useModelInstances } from "@/lib/model-catalog.ts";
import { SignInButton, useSignIn } from "@/features/sign-in/index.ts";

/** Problems that signing in to the upstream fixes. */
const signInFixes = new Set<ModelDiscoveryError["code"]>([
  "not_configured",
  "auth_expired",
  "no_models",
]);

/**
 * The upstreams OpenCode or Pi reaches models through (OpenCode Go and Zen, GitHub Copilot, the
 * person's API-key providers), as the model catalog last found them, each with its own sign-in.
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
          {listed.map(({ source, error }) => {
            const fix = error && signInFixes.has(error.code);
            return (
              <li key={source.id} className="flex min-h-8 items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-foreground">{source.label}</span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {error ? error.message : "Connected"}
                  </span>
                </span>
                <SignInButton
                  variant={fix ? "secondary" : "ghost"}
                  label={`${fix ? "Sign in to" : "Reconnect"} ${source.label}`}
                  target={{ provider: props.provider, choice: source.id }}
                >
                  {fix ? "Sign in" : "Reconnect"}
                </SignInButton>
              </li>
            );
          })}
        </ul>
      )}
      <SignInButton variant="link" target={{ provider: props.provider }}>
        Connect another provider to {props.name}
      </SignInButton>
    </div>
  );
}
