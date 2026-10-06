import type { Session } from "electron";
/**
 * Everything an ephemeral session left behind (storage, cookies, caches, auth, DNS, open
 * connections), so the partition can serve the next session. False if any of it failed.
 */
export async function clearPartition(session: Session): Promise<boolean> {
  try {
    await session.closeAllConnections();
    await session.clearData();
    await session.clearStorageData();
    await session.clearCache();
    await session.clearAuthCache();
    await session.clearHostResolverCache();
    await session.clearCodeCaches({});
    return true;
  } catch {
    return false;
  }
}
