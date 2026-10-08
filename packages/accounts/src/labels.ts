/** A named account starts with its first letter; the CLI login needs no badge. */
export function accountShortLabel(account: {
  label: string;
  implicit?: boolean | undefined;
  shortLabel?: string | undefined;
}): string | undefined {
  return (
    account.shortLabel ??
    (account.implicit ? undefined : Array.from(account.label.trim())[0]?.toLocaleUpperCase())
  );
}
