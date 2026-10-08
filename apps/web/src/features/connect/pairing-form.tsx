import { useState } from "react";
import { AccessClient } from "@ace/client/access";
import { ClientError } from "@ace/client";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { DaemonTarget, type DaemonTarget as Target } from "@/boot/connection-settings.ts";

/** A person's confirmation precedes redemption. Fragment credentials never enter HTTP URLs. */
export function PairingForm(props: {
  link?: string | undefined;
  url: string;
  connect(target: Target, remember: boolean): void;
  cancel(): void;
}) {
  const [link, setLink] = useState(props.link ?? "");
  const [address, setAddress] = useState(props.url);
  const [name, setName] = useState("");
  const [remember, setRemember] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setError("");
    setPending(true);
    try {
      let origin: string;
      let code = link.trim();
      if (code.includes("://")) {
        const url = new URL(code);
        if (url.username || url.password || url.search || url.pathname !== "/pair")
          throw new Error("Use the complete pairing link from your host computer.");
        code = new URLSearchParams(url.hash.slice(1)).get("code") ?? "";
        origin = `${url.origin}/`;
      } else {
        const url = new URL(address);
        url.protocol =
          url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
        origin = `${url.origin}/`;
      }
      if (!code || !name.trim())
        throw new Error("Enter the pairing link and a name for this device.");
      const access = new AccessClient({
        origin,
        fetch: (input, init) => fetch(input, init),
        token: async () => "",
      });
      const paired = await access.redeem(code, name.trim());
      const url = new URL(origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      props.connect(
        DaemonTarget.parse({
          url: url.toString(),
          token: paired.token,
          pairedDeviceId: paired.device.id,
        }),
        remember,
      );
    } catch (reason) {
      setError(
        reason instanceof ClientError && reason.message === "HTTP 401"
          ? "This link expired or has already been used. Create a new one on the host computer."
          : reason instanceof ClientError && reason.message === "HTTP 429"
            ? "Too many pairing attempts. Wait a minute, then try again."
            : reason instanceof TypeError || reason instanceof ClientError
              ? "Couldn't pair with this computer. Check the address, trust its HTTPS certificate in this browser, and try a fresh link."
              : reason instanceof Error
                ? reason.message
                : "Couldn't pair. Create a new link and try again.",
      );
      setPending(false);
    }
  };
  return (
    <form
      aria-label="Pair this device"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) void submit();
      }}
    >
      <label className="text-ui">
        Pairing link or code
        <Input
          type="password"
          aria-label="Pairing link or code"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          autoComplete="off"
          disabled={pending}
        />
      </label>
      {!link.includes("://") && (
        <label className="text-ui">
          Computer address
          <Input
            aria-label="Computer address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            inputMode="url"
            disabled={pending}
          />
        </label>
      )}
      <label className="text-ui">
        This device's name
        <Input
          aria-label="This device's name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="My phone"
          maxLength={256}
          autoComplete="off"
          disabled={pending}
        />
      </label>
      <label className="flex items-center justify-between gap-4 text-ui">
        Remember on this device
        <Switch checked={remember} onCheckedChange={setRemember} disabled={pending} />
      </label>
      <p className="text-sm text-muted-foreground">
        Only use a link from your own computer. Pairing gives this device the access chosen there.{" "}
        {remember
          ? "Access stays until you disconnect or revoke this device."
          : "Access ends when this browser session closes."}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={props.cancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Pairing…" : "Pair and connect"}
        </Button>
      </div>
    </form>
  );
}
