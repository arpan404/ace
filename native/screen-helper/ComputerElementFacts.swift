/**
 * What a walk learned about elements that rarely changes, so the next walk asks less.
 *
 * - The role predicts which attributes an element needs, so a known element is read in one
 *   round trip instead of two. The prediction is checked: the role is read in that same round
 *   trip, and a different role (an element object reused for something else) re-reads.
 * - Action names are reused until the app reports a change on that element, the element is
 *   destroyed or `maxAgeNs` passes (apps that change without telling accessibility).
 *
 * Pure and generic over the key; the engine keys by AX element.
 */
struct CUElementFacts<Key: Hashable> {
    let maxAgeNs: UInt64
    let capacity: Int
    private var roles: [Key: String] = [:]
    private var actions: [Key: (names: [String], at: UInt64)] = [:]

    init(maxAgeNs: UInt64 = 10_000_000_000, capacity: Int = 8_192) {
        self.maxAgeNs = maxAgeNs
        self.capacity = capacity
    }

    func role(of key: Key) -> String? { roles[key] }

    /// The role read now. A different role than remembered means a different element.
    mutating func read(role: String, of key: Key) {
        if let known = roles[key], known != role { actions.removeValue(forKey: key) }
        if roles.count >= capacity, roles[key] == nil { roles.removeAll(); actions.removeAll() }
        roles[key] = role
    }

    func actions(of key: Key, now: UInt64) -> [String]? {
        guard let entry = actions[key], now >= entry.at, now - entry.at <= maxAgeNs else { return nil }
        return entry.names
    }

    mutating func read(actions names: [String], of key: Key, at now: UInt64) {
        if actions.count >= capacity, actions[key] == nil { actions.removeAll() }
        actions[key] = (names, now)
    }

    /// The app reported a change on this element (its value, title, children…).
    mutating func changed(_ key: Key) { actions.removeValue(forKey: key) }

    /// The element is gone; its object may be reused for another element.
    mutating func destroyed(_ key: Key) {
        roles.removeValue(forKey: key)
        actions.removeValue(forKey: key)
    }
}
