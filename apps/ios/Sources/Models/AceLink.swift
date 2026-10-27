import Foundation

/// Links into ace that other apps and Copy link hand around: `ace://thread/<id>?machine=<host>`,
/// the same scheme the desktop app opens. Reading one is the shared runtime's (`deep-link.ts`).
enum AceLink {
    static let scheme = "ace"

    static func thread(_ id: String, machine: String?) -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "thread"
        components.path = "/" + id
        if let machine, !machine.isEmpty { components.queryItems = [URLQueryItem(name: "machine", value: machine)] }
        return components.url ?? URL(string: "ace://thread")!
    }
}

/// An `ace://` link as the shared runtime read it (`readAceLink`).
struct OpenedLink: Decodable, Equatable, Sendable {
    let kind: String
    var threadId: String? = nil
    var itemId: String? = nil
    var machine: String? = nil
    var page: String? = nil
    var project: String? = nil
}
private struct LinkReply: Decodable { let link: OpenedLink? }

extension MachineInbox {
    /// Reads `url` with the shared rules on any paired machine's runtime; nil when it isn't an
    /// ace link or no machine is paired yet.
    func readLink(_ url: URL) async -> OpenedLink? {
        guard url.scheme?.lowercased() == AceLink.scheme, let client = sessions.first?.client else { return nil }
        return try? await client.service(["type": "link.read", "url": url.absoluteString], as: LinkReply.self).link
    }
    /// The machine holding `threadId`: the one the link names when it holds it, else any that does.
    func machine(holding threadId: String, named: String?) -> String? {
        if let named, client(named)?.inbox[threadId] != nil { return named }
        return sessions.first { $0.client.inbox[threadId] != nil }?.hostId
    }
}

extension SettingsRoute {
    /// The Settings page a link names, by the web's page names where the phone has one.
    static func linked(_ page: String?) -> [SettingsRoute] {
        switch page {
        case "machines", "devices": [.machines]
        case "pair": [.pair]
        case "notifications": [.notifications]
        case "appearance", "general": [.appearance]
        case "archive", "archived": [.archive]
        case "profiles": [.profiles]
        case "licences", "licenses", "about": [.licences]
        default: []
        }
    }
}

/// Links that arrived before the app could open them: at a cold launch, before the paired
/// machines are read, while the app is locked. Kept in order until the inbox is ready, then
/// handed over once each.
struct PendingLinks: Equatable {
    private(set) var waiting: [URL] = []
    mutating func add(_ url: URL) {
        guard url.scheme?.lowercased() == AceLink.scheme else { return }
        // A link opened twice before the app is ready opens once.
        if !waiting.contains(url) { waiting.append(url) }
    }
    /// Every kept link, oldest first, once the app is unlocked and a machine's runtime can read
    /// them; nothing before then.
    mutating func take(unlocked: Bool, machinesReady: Bool) -> [URL] {
        guard unlocked, machinesReady, !waiting.isEmpty else { return [] }
        defer { waiting = [] }
        return waiting
    }
}
