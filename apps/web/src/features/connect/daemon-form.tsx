import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { useForm } from "@tanstack/react-form";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import {
  DaemonToken,
  DaemonUrl,
  targetFromFragment,
  type DaemonTarget,
} from "@/boot/connection-settings.ts";
import { isLoopbackUrl } from "@/boot/fragment-handoff.ts";
import { cn } from "@/lib/cn.ts";
import { CopyCommand } from "@/components/copy-command.tsx";

const FormValues = z.object({ url: DaemonUrl, token: DaemonToken, remember: z.boolean() });

function firstError(errors: readonly unknown[]): string | undefined {
  for (const error of errors) {
    if (typeof error === "string") return error;
    if (
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string"
    )
      return error.message;
  }
  return undefined;
}

/** A pasted `…#token=…&daemon=…` link, the one `ace start` opens, read like the boot does. */
function linkTarget(value: string, url: string): DaemonTarget | undefined {
  const hash = value.indexOf("#");
  if (hash < 0 || !value.includes("token=")) return undefined;
  return targetFromFragment(value.slice(hash), url);
}

/** On for a daemon on this computer, off elsewhere, until the person sets it themselves. */
function rememberByDefault(url: string): boolean {
  try {
    return isLoopbackUrl(url);
  } catch {
    return false;
  }
}

/**
 * Address + token + "remember", validated with the same schemas the gate parses with. While
 * the gate tries a target the fields are read-only and `actions` replace the submit button.
 */
export function DaemonForm(props: {
  url: string;
  /** The token last tried, kept when an attempt fails. */
  token?: string | undefined;
  remembered: boolean;
  submitLabel: string;
  onSubmit(target: DaemonTarget, remember: boolean): void;
  /** Fields can't change while a connection is being tried. */
  readOnly?: boolean;
  /** Said above the buttons (`role="alert"`): why the last attempt didn't work. */
  alert?: ReactNode;
  /** While read-only, the main button does this instead of submitting (Try again). */
  primary?: { label: string; run(): void } | undefined;
  /** The main button waits (Connecting…), still focusable so focus stays put. */
  pending?: boolean;
  /** A second button beside the main one (Cancel, Edit). */
  secondary?: { label: string; run(): void } | undefined;
  /** Focus and select the token: the daemon rejected it. */
  selectToken?: boolean;
  /** The connect screen's full-width button; Settings keeps a compact one. */
  wide?: boolean;
}) {
  const ids = useId();
  const tokenRef = useRef<HTMLInputElement>(null);
  const [showToken, setShowToken] = useState(false);
  // "Remember" follows the address (CN-4) until the person flips it.
  const [rememberTouched, setRememberTouched] = useState(props.remembered);
  const form = useForm({
    defaultValues: {
      url: props.url,
      token: props.token ?? "",
      remember: props.remembered || rememberByDefault(props.url),
    },
    validators: { onSubmit: FormValues },
    onSubmit: ({ value }) => {
      const parsed = FormValues.parse(value);
      props.onSubmit({ url: parsed.url, token: parsed.token }, parsed.remember);
    },
  });
  const selectToken = props.selectToken;
  useEffect(() => {
    if (!selectToken) return;
    tokenRef.current?.focus();
    tokenRef.current?.select();
  }, [selectToken]);
  // Back to editing (Edit, Cancel): the buttons that had focus are gone; the token is next.
  const readOnly = props.readOnly ?? false;
  const wasReadOnly = useRef(readOnly);
  useEffect(() => {
    if (wasReadOnly.current && !readOnly) tokenRef.current?.focus();
    wasReadOnly.current = readOnly;
  }, [readOnly]);
  const setUrl = (url: string) => {
    form.setFieldValue("url", url);
    if (!rememberTouched) form.setFieldValue("remember", rememberByDefault(url));
  };
  return (
    <form
      aria-label="Daemon connection"
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!props.readOnly) void form.handleSubmit();
      }}
    >
      <form.Field name="url">
        {(field) => {
          const error = firstError(field.state.meta.errors);
          return (
            <FieldRow id={`${ids}-url`} label="Daemon address" error={error}>
              <Input
                id={`${ids}-url`}
                value={field.state.value}
                onChange={(event) => setUrl(event.target.value)}
                onBlur={field.handleBlur}
                readOnly={props.readOnly}
                spellCheck={false}
                autoComplete="off"
                inputMode="url"
                {...(error ? describedBy(`${ids}-url`, error) : {})}
                className="font-mono text-sm read-only:text-muted-foreground"
              />
            </FieldRow>
          );
        }}
      </form.Field>
      <form.Field name="token">
        {(field) => {
          const error = firstError(field.state.meta.errors);
          return (
            <FieldRow
              id={`${ids}-token`}
              label="Token"
              hint={
                <>
                  On the daemon's machine, run <CopyCommand command="ace token" /> and paste the
                  result.
                </>
              }
              error={error}
            >
              <div className="relative">
                <Input
                  ref={tokenRef}
                  id={`${ids}-token`}
                  type={showToken ? "text" : "password"}
                  value={field.state.value}
                  onChange={(event) => {
                    const value = event.target.value;
                    const link = linkTarget(value, form.getFieldValue("url"));
                    if (!link) {
                      field.handleChange(value);
                      return;
                    }
                    // A pasted link carries the token, and the address when it names one.
                    field.handleChange(link.token);
                    if (value.includes("daemon=")) setUrl(link.url);
                  }}
                  onBlur={field.handleBlur}
                  readOnly={props.readOnly}
                  // The connect screen exists to take this one value.
                  autoFocus={!props.readOnly && props.wide}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="64 hexadecimal characters"
                  {...describedBy(`${ids}-token`, error)}
                  className="pr-9 font-mono text-sm read-only:text-muted-foreground"
                />
                <IconButton
                  icon={showToken ? EyeSlashIcon : EyeIcon}
                  label={showToken ? "Hide token" : "Show token"}
                  size="sm"
                  type="button"
                  pressed={showToken}
                  onClick={() => setShowToken(!showToken)}
                  className="absolute top-1 right-1"
                />
              </div>
            </FieldRow>
          );
        }}
      </form.Field>
      <form.Field name="remember">
        {(field) => (
          <label className="flex items-center justify-between gap-4 text-ui">
            <span>
              Remember on this device
              <span className="block text-sm text-muted-foreground">
                {field.state.value
                  ? "Stays until you disconnect."
                  : "Forgotten when this window closes. Recommended on shared computers."}
              </span>
            </span>
            <Switch
              checked={field.state.value}
              disabled={props.readOnly}
              onCheckedChange={(checked) => {
                setRememberTouched(true);
                field.handleChange(checked);
              }}
            />
          </label>
        )}
      </form.Field>
      {props.alert && (
        <div
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2.5 text-ui leading-normal text-foreground"
        >
          {props.alert}
        </div>
      )}
      <div className={cn("flex gap-2", !props.wide && "self-start")}>
        <Button
          type={props.readOnly ? "button" : "submit"}
          variant="primary"
          disabled={props.pending}
          focusableWhenDisabled
          onClick={props.readOnly ? props.primary?.run : undefined}
          className={cn(props.wide && "h-9 flex-1")}
        >
          {props.pending && <Spinner className="text-current" />}
          {(props.readOnly && props.primary?.label) || props.submitLabel}
        </Button>
        {props.secondary && (
          <Button type="button" onClick={props.secondary.run} className={cn(props.wide && "h-9")}>
            {props.secondary.label}
          </Button>
        )}
      </div>
    </form>
  );
}

function describedBy(id: string, error: string | undefined) {
  return {
    "aria-describedby": `${id}-note`,
    ...(error ? { "aria-invalid": true } : {}),
  };
}

function FieldRow(props: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.id} className="text-ui font-medium">
        {props.label}
      </label>
      {props.children}
      {props.error ? (
        <p id={`${props.id}-note`} role="alert" className="text-sm text-destructive">
          {props.error}
        </p>
      ) : (
        props.hint && (
          <p id={`${props.id}-note`} className="text-sm leading-normal text-muted-foreground">
            {props.hint}
          </p>
        )
      )}
    </div>
  );
}
