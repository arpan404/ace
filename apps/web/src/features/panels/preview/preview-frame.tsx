import type { PreviewGatewayStatus } from "@ace/protocol";
import { useState } from "react";
import type { PreviewServer, PreviewSource } from "../sources.ts";
import { DevServerFrame, OpenOutside, type FramePhase } from "./dev-server-frame.tsx";
import { gatewayFailure, signInAgainHelps, signInFailure } from "./preview-errors.ts";
import { usePreviewSignIn } from "./use-preview-sign-in.ts";

/** The address a dev server's preview shows: the gateway origin, or the server's own. */
export const previewUrl = (server: Pick<PreviewServer, "port" | "origin">) =>
  server.origin ?? `http://localhost:${server.port}`;

/**
 * A dev server's preview in a frame, signed in through the daemon's preview gateway. When the
 * gateway's refusal page says the sign-in is missing or spent, the frame signs in once more on
 * its own; refused again (a browser that drops the cookie) it shows what happened.
 */
export function PreviewFrame(props: {
  source: PreviewSource;
  threadId: string;
  server: Pick<PreviewServer, "port" | "origin">;
  attempt: number;
  onPhase(phase: FramePhase): void;
  onRetry(): void;
}) {
  const { server } = props;
  const [again, setAgain] = useState({ attempt: props.attempt, count: 0 });
  const count = again.attempt === props.attempt ? again.count : 0;
  const load = `${props.attempt}.${count}`;
  const signIn = usePreviewSignIn(props.source, props.threadId, server, load);
  const [refused, setRefused] = useState<{ load: string; status: PreviewGatewayStatus }>();
  const onGatewayStatus = (status: PreviewGatewayStatus) => {
    // Once per user load, and again only after a background renewal: a browser that drops the
    // cookie is refused straight after every sign-in, so it must not loop.
    const renewed = signIn.phase === "ready" && signIn.renewals > 0;
    if (signInAgainHelps(status) && (count === 0 || renewed))
      setAgain({ attempt: props.attempt, count: count + 1 });
    else setRefused({ load, status });
  };
  const status = refused?.load === load ? refused.status : undefined;
  const failure =
    signIn.phase === "failed"
      ? signIn.failure
      : status
        ? gatewayFailure(status, server.port)
        : undefined;
  return (
    <DevServerFrame
      url={previewUrl(server)}
      src={signIn.phase === "ready" ? signIn.src : undefined}
      load={load}
      failure={failure}
      onGatewayStatus={server.origin ? onGatewayStatus : undefined}
      onPhase={props.onPhase}
      onRetry={props.onRetry}
    />
  );
}

/** "Open in your browser" for a preview: a fresh sign-in link, asked for on the click. */
export function OpenPreviewOutside(props: {
  source: PreviewSource;
  threadId: string;
  server: Pick<PreviewServer, "port" | "origin">;
}) {
  const { source, threadId, server } = props;
  const address = server.origin
    ? () =>
        source.link(threadId, server.port).then(
          (link) => link.url,
          (error: unknown) => {
            const failure = signInFailure(error, server.port);
            throw new Error(`${failure.title}. ${failure.detail}`);
          },
        )
    : undefined;
  return <OpenOutside url={previewUrl(server)} address={address} />;
}
