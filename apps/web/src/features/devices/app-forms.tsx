import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

/** One field and its action on a single row; Enter submits. */
function AppForm(props: {
  label: string;
  placeholder: string;
  action: string;
  disabled: boolean;
  check?(value: string): string | undefined;
  onSubmit(value: string): void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        const text = value.trim();
        if (!text) return;
        const problem = props.check?.(text);
        setError(problem);
        if (problem) return;
        props.onSubmit(text);
        setValue("");
      }}
    >
      <label className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-ui text-muted-foreground">{props.label}</span>
        <Input
          aria-label={props.label}
          placeholder={props.placeholder}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          className="h-8 min-w-0 flex-1"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={props.disabled || !value.trim()}
          className="w-20 shrink-0"
        >
          {props.action}
        </Button>
      </label>
      {error && (
        <p role="alert" className="pl-22 text-xs text-status-failed">
          {error}
        </p>
      )}
    </form>
  );
}

/** Install a build, launch an installed app, or open a link on the device. */
export function AppForms(props: {
  disabled: boolean;
  onInstall(path: string): void;
  onLaunch(appId: string): void;
  onOpenUrl(url: string): void;
}) {
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <AppForm
        label="Install"
        placeholder="/path/to/App.app or app.apk"
        action="Install"
        disabled={props.disabled}
        onSubmit={props.onInstall}
      />
      <AppForm
        label="Launch"
        placeholder="com.example.app"
        action="Launch"
        disabled={props.disabled}
        onSubmit={props.onLaunch}
      />
      <AppForm
        label="Open URL"
        placeholder="https://example.com"
        action="Open"
        disabled={props.disabled}
        check={(url) =>
          URL.canParse(url) ? undefined : "Enter a complete URL, such as https://example.com."
        }
        onSubmit={props.onOpenUrl}
      />
    </div>
  );
}
