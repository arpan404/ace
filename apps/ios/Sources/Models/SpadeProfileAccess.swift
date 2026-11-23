import Foundation

/// What a bot may use and where it lives, as the bridge shapes it (`bridge/spade-profile-access.ts`):
/// its apps and plugins, its move to another machine, and what deleting it asks first.
enum SpadeProfileAccess {
    struct App: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        let account: String?
    }
    struct Apps: Decodable, Equatable, Sendable {
        let allowed: [App]
        /// Connected apps it doesn't have yet, for Add an app.
        let others: [App]
    }
    struct Plugin: Decodable, Equatable, Sendable, Identifiable {
        let name: String
        let line: String
        let on: Bool
        /// Off in ace: off for every bot, and its switch can't turn on.
        let offInAce: Bool
        let notes: [String]
        var id: String { name }
    }
    struct Plugins: Decodable, Equatable, Sendable {
        let cli: Bool
        let problem: String?
        let plugins: [Plugin]
    }
    /// What the person accepts on the machine the bot goes to.
    struct Accept: Codable, Equatable, Sendable {
        let bot: String
        let from: String
        let via: String
        let to: String
        let digest: String
        let replaces: String
        var payload: [String: Any] {
            ["bot": bot, "from": from, "via": via, "to": to, "digest": digest, "replaces": replaces]
        }
    }
    struct Move: Decodable, Equatable, Sendable {
        let line: String
        let failed: Bool
        let arrived: Bool
        let moving: Bool
        let canCancel: Bool
        let canKeep: Bool
        let check: Bool
        let to: String?
        let accept: Accept?
    }
    struct Delete: Decodable, Equatable, Sendable {
        /// It made workers: stop them, or keep them going.
        let asks: Bool
        let stop: String
        let keep: String
    }

    /// A new move's id, as Spade takes them: one plain lowercase name.
    static func moveId(_ uuid: UUID) -> String {
        "mv_" + uuid.uuidString.lowercased().filter(\.isHexDigit)
    }
}
