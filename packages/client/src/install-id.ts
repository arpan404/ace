import { InstallId } from "@ace/protocol";

/**
 * This app install's own identity (ADR 0115): one UUIDv7, made on first run and kept for good.
 * It names the install to every machine on every path (a pairing's device, an ace account
 * device grant's subject), so signing out and in, pairing again or switching networks never
 * makes the install a second device. Pure: storage and the id maker are passed in.
 */
export interface InstallIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const key = "ace.install.id";
/** Where builds before install ids kept the account device id; adopted so grants keep it. */
const legacyAccountKey = "ace.account.deviceId";

/** The install id kept in `storage`; made with `make` (and kept) only when none is there. */
export function appInstallId(storage: InstallIdStorage, make: () => string): InstallId {
  const read = (name: string) => {
    try {
      const parsed = InstallId.safeParse(storage.getItem(name));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };
  const kept = read(key) ?? read(legacyAccountKey);
  const id = kept ?? InstallId.parse(make());
  if (read(key) !== id) {
    try {
      storage.setItem(key, id);
    } catch {
      // Storage refused (private mode, full): the id still holds for this run.
    }
  }
  return id;
}

/**
 * The install id resolved once and then held: every caller in this run gets the same id, even
 * when storage refuses to keep it (private mode, full), where reading it again would make a
 * new one each time.
 */
export function installIdentity(storage: InstallIdStorage, make: () => string): () => InstallId {
  let resolved: InstallId | undefined;
  return () => (resolved ??= appInstallId(storage, make));
}

/**
 * A UUIDv7 (RFC 9562 §5.7) from a Unix millisecond time and 10 random bytes: time ordered, so
 * an install's id also says roughly when it was made.
 */
export function uuidV7(ms: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms >= 2 ** 48) throw new Error("Invalid timestamp");
  if (random.length < 10) throw new Error("UUIDv7 needs 10 random bytes");
  const bytes = new Uint8Array(16);
  for (let index = 5, rest = ms; index >= 0; index--, rest = Math.floor(rest / 256))
    bytes[index] = rest % 256;
  bytes.set(random.subarray(0, 10), 6);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
