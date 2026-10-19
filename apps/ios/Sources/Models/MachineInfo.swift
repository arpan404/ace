import Foundation

/// `machine.status` (`bridge/machine-info.ts`): the shared connection word and when this phone
/// last saw the computer (epoch ms; now while connected).
struct MachineStatusInfo: Codable, Sendable, Equatable {
    let status: StatusDisplay
    let seenAt: Double?
}

/// `machine.providers`: the coding-agent CLIs a computer reports, worded by `@ace/ui-core/mobile`.
struct MachineProvidersInfo: Codable, Sendable, Equatable {
    struct Usage: Codable, Sendable, Hashable { let label: String; let left: String; let resets: String? }
    struct Provider: Codable, Sendable, Equatable, Identifiable {
        let provider: String
        let name: String
        let status: StatusDisplay
        let summary: String
        let version: String?
        let usage: [Usage]
        var id: String { provider }
    }
    let providers: [Provider]
    /// CLIs that aren't installed or are turned off, by name.
    let absent: [String]
    /// The daemon's version, when it answered.
    let version: String?
    /// Why the CLIs couldn't be read, for a person; nil when they were.
    let problem: String?
}
