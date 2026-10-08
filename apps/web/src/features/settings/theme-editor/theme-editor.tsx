import { useCallback, useEffect, useMemo, useRef } from "react";
import { StatusLabel } from "@/components/status-label.tsx";
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
  const { theme, appearance, update, saveTheme } = useTheme();
  const toast = useToast();
  const warnings = useMemo(() => contrastWarnings(theme.tokens), [theme.tokens]);
  const warned = useMemo(() => new Set(warnings.map((warning) => warning.token)), [warnings]);

  const current = useRef(theme);
  const following = useRef(appearance.theme === "system");
  useEffect(() => {
    current.current = theme;
    following.current = appearance.theme === "system";
  });
  const onChange = useCallback(
    (token: TokenName, value: string) => {
      const base = current.current.name;
      const edit = editToken(current.current, token, value, newSuffix());
      // Keep the ref ahead of the re-render so fast typing never forks twice.
      current.current = edit.theme;
      saveTheme(edit.theme);
      if (!edit.forked) return;
      // Read before switching: the switch re-renders at once and the ref follows it.
      const wasSystem = following.current;
      update({ theme: edit.theme.id });
      if (wasSystem) {
        // Editing a copy pins it, so the OS's light/dark no longer switches the theme: say so.
        toast.add({
          title: `Editing a copy of ${base} · System theme turned off`,
          actionProps: { children: "Undo", onClick: () => update({ theme: "system" }) },
        });
      } else toast.add({ title: `Editing a copy · ${edit.theme.name}` });
    },
    [saveTheme, update, toast],
  );

  return (
    <>
      <EditorToolbar />
      <ContrastNotice warnings={warnings} />
      {tokenGroups.map((group) => (
        <section key={group.name} aria-label={group.name} className="mt-6">
          <h3 className="mb-1.5 text-sm font-medium text-muted-foreground">{group.name}</h3>
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

function ContrastNotice(props: { warnings: ContrastWarning[] }) {
  const count = props.warnings.length;
  return (
    <div role="status" className="mt-3.5 text-sm text-muted-foreground">
      <StatusLabel
        tone={count ? "failed" : "done"}
        label={
          count ? `${count} contrast warning${count === 1 ? "" : "s"}` : "Contrast looks good."
        }
      />
      {count > 0 && (
        <ul className="mt-1">
          {props.warnings.map((warning) => (
            <li key={warning.token}>
              {warning.label}: {warning.ratio.toFixed(2)}:1; needs {warning.minimum}:1.
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
