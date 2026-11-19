import Foundation

/// What each pairing lets this phone do, by machine and device. One install id names this phone
/// on every machine it pairs with (ADR 0115), so a device id alone no longer tells two pairings
/// apart: a view-only pairing with one machine must not take operate away from another. Pure;
/// saved as a plain dictionary. Builds before this kept grants by device id alone; `adopt`
/// moves each to the paired machine that uses that device.
struct GrantBook: Equatable, Sendable {
    private(set) var saved: [String: [String]]
    init(_ saved: [String: [String]]) { self.saved = saved }

    func scopes(for entry: MachineEntry) -> [String]? { saved[Self.key(entry)] ?? saved[entry.deviceId] }
    mutating func set(_ scopes: [String]?, for entry: MachineEntry) {
        saved[Self.key(entry)] = scopes
        if scopes == nil { saved[entry.deviceId] = nil }
    }
    /// Grants saved by device alone, moved to the paired machines using that device. True when
    /// anything moved, so the caller saves.
    mutating func adopt(_ paired: [MachineEntry]) -> Bool {
        var changed = false
        for entry in paired where saved[Self.key(entry)] == nil {
            guard let legacy = saved[entry.deviceId] else { continue }
            saved[Self.key(entry)] = legacy
            changed = true
        }
        for entry in paired where saved[entry.deviceId] != nil {
            saved[entry.deviceId] = nil
            changed = true
        }
        return changed
    }
    private static func key(_ entry: MachineEntry) -> String { "\(entry.hostId)|\(entry.deviceId)" }
}
