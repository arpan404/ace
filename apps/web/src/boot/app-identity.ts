import { z } from "zod";
const identity = z
  .object({
    bundleId: z.string().max(256),
    displayName: z.string().min(1).max(256),
    icon: z
      .string()
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
      .max(128 * 1024)
      .nullable(),
  })
  .nullable();
export type AppIdentity = z.infer<typeof identity>;
/** Desktop-only system metadata. Browser clients can use their bundle-id name fallback. */
export function appIdentityReader(
  scope: object = globalThis,
): ((bundleId: string) => Promise<AppIdentity>) | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  if (ace === null || typeof ace !== "object" || !("shell" in ace)) return;
  const shell: unknown = ace.shell;
  if (shell === null || typeof shell !== "object" || !("appIdentity" in shell)) return;
  const read: unknown = shell.appIdentity;
  if (typeof read !== "function") return;
  return async (bundleId) => {
    try {
      const value: unknown = await Reflect.apply(read, shell, [bundleId]);
      const checked = identity.safeParse(value);
      return checked.success && checked.data?.bundleId === bundleId ? checked.data : null;
    } catch {
      return null;
    }
  };
}
