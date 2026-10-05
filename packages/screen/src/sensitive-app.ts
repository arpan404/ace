export function sensitiveApp(bundle: string): boolean {
  return /(?:1password|bitwarden|lastpass|dashlane|keepass|keeper|enpass|protonpass|password|keychain|systempreferences|systemsettings|terminal|iterm|^dev\.ace\.app(?:\.|$)|^com\.ace\.app(?:\.|$))/i.test(
    bundle,
  );
}
