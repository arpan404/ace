import { CompassIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Link, useRouter, useRouterState, type ErrorComponentProps } from "@tanstack/react-router";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { BootFailure } from "@/features/connect/index.ts";
import { Screen } from "@/features/shell/index.ts";

/** An address no route matches: inside the shell, with the address and a way home. */
export function RouteNotFound() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <Screen title="Not found">
      <EmptyState
        icon={CompassIcon}
        title="This page doesn't exist"
        description={<code className="font-mono text-sm break-all">{pathname}</code>}
        action={
          <Link to="/" className={buttonVariants({ variant: "primary" })}>
            Go to Home
          </Link>
        }
        heading
      />
    </Screen>
  );
}

/** A route that threw while loading or rendering: the shell stays, with the reason. */
export function RouteError(props: ErrorComponentProps) {
  const router = useRouter();
  const message = props.error instanceof Error ? props.error.message : String(props.error);
  return (
    <Screen title="Something went wrong">
      <EmptyState
        icon={WarningCircleIcon}
        title="Something went wrong on this page"
        description={
          <code className="block max-h-40 overflow-auto font-mono text-sm break-words whitespace-pre-wrap">
            {message}
          </code>
        }
        action={
          <span className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => {
                props.reset();
                void router.invalidate();
              }}
            >
              Try again
            </Button>
            <Link to="/" className={buttonVariants()}>
              Go to Home
            </Link>
          </span>
        }
        heading
      />
    </Screen>
  );
}

/** The root route itself failed, so there is no shell to show an error in. */
export function RootError(props: ErrorComponentProps) {
  return <BootFailure error={props.error} />;
}
