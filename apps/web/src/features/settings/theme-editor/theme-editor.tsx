import { useCallback, useEffect, useMemo, useRef } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { contrastWarnings, type ContrastWarning } from "@/theme/contrast.ts";
import { tokenGroups, type TokenName } from "@/theme/tokens.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { editToken } from "./editor-model.ts";
import { EditorToolbar } from "./editor-toolbar.tsx";
import { newSuffix } from "./suffix.ts";
import { TokenRow } from "./token-row.tsx";

/**
 * Every token of the theme on screen, grouped, with live apply. Editing a preset forks it into
 * a custom theme you own; the fork is applied at once so you keep seeing what you edit.
 */
export function ThemeEditor() {
  const { theme, update, saveTheme } = useTheme();
  const toast = useToast();
  const warnings = useMemo(() => contrastWarnings(theme.tokens), [theme.tokens]);
  const warned = useMemo(() => new Set(warnings.map((warning) => warning.token)), [warnings]);

  const current = useRef(theme);
  useEffect(() => {
    current.current = theme;
  });
  const onChange = useCallback(
    (token: TokenName, value: string) => {
      const edit = editToken(current.current, token, value, newSuffix());
      // Keep the ref ahead of the re-render so fast typing never forks twice.
      current.current = edit.theme;
      saveTheme(edit.theme);
      if (edit.forked) {
        update({ theme: edit.theme.id });
        toast.add({ title: `Editing a copy · ${edit.theme.name}` });
      }
    },
    [saveTheme, update, toast],
  );

  return (
    <>
      <EditorToolbar />
      <ContrastBanner warnings={warnings} />
      {tokenGroups.map((group) => (
        <section key={group.name} aria-label={group.name} className="mt-6">
          <h3 className="mb-1.5 text-[12px] font-semibold tracking-[0.01em] text-subtle-foreground">
            {group.name}
          </h3>
          {group.tokens.map((token) => (
            <TokenRow
              key={token}
              token={token}
              value={theme.tokens[token]}
              warning={warned.has(token)}
              onChange={onChange}
            />
          ))}
        </section>
      ))}
    </>
  );
}

function ContrastBanner(props: { warnings: ContrastWarning[] }) {
  const count = props.warnings.length;
  if (count === 0)
    return (
      <p
        role="status"
        className="mt-3.5 rounded-card bg-[color-mix(in_oklab,var(--status-done)_9%,transparent)] px-3 py-2.5 text-sm leading-normal"
      >
        <b className="font-medium">Contrast looks good.</b> Text, buttons and status colours all
        clear WCAG AA against the background.
      </p>
    );
  return (
    <div
      role="status"
      className="mt-3.5 rounded-card bg-[color-mix(in_oklab,var(--status-needs-you)_9%,transparent)] px-3 py-2.5 text-sm leading-normal"
    >
      <b className="font-medium">
        {count} contrast warning{count === 1 ? "" : "s"}
      </b>
      <ul>
        {props.warnings.map((warning) => (
          <li key={warning.token}>
            {warning.label} ({warning.token}) is {warning.ratio.toFixed(2)}:1; needs{" "}
            {warning.minimum}:1.
          </li>
        ))}
      </ul>
    </div>
  );
}
