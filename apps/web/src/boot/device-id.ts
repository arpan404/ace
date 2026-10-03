/** This browser's device id, created once and kept in localStorage. */
export function deviceId(): string {
  const key = "ace.deviceId";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const created = `web-${crypto.randomUUID()}`;
  localStorage.setItem(key, created);
  return created;
}
