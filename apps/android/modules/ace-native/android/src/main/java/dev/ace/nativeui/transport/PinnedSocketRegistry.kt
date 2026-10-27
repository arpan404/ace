package dev.ace.nativeui.transport

/**
 * Identity-keyed registry for pinned sockets sharing a JS-visible id.
 *
 * A reopen with the same id replaces the entry and closes the previous
 * socket. The previous socket's late `onClose` must never evict the
 * replacement: every removal compares the stored instance by identity and
 * only removes when it is still the entry for that id. All methods are
 * synchronized so an OkHttp callback thread racing a bridge call cannot
 * interleave a check with a replace.
 */
class PinnedSocketRegistry<T : Any> {
  private val entries = mutableMapOf<String, T>()

  /**
   * Store [socket] under [id], returning the displaced entry (if any) so
   * the caller can close it. Replacing an id with itself returns null.
   */
  @Synchronized
  fun replace(id: String, socket: T): T? {
    val previous = entries.put(id, socket)
    return if (previous === socket) null else previous
  }

  @Synchronized
  fun current(id: String): T? = entries[id]

  @Synchronized
  fun isCurrent(id: String, socket: T): Boolean = entries[id] === socket

  /**
   * Remove [id] only when [socket] is still its entry. A stale close from
   * a replaced socket returns false and leaves the replacement in place.
   */
  @Synchronized
  fun removeIfCurrent(id: String, socket: T): Boolean {
    if (entries[id] !== socket) return false
    entries.remove(id)
    return true
  }

  /** Unconditional removal for an explicit close of whatever is current. */
  @Synchronized
  fun take(id: String): T? = entries.remove(id)
}
