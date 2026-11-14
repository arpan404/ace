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

    /// The machine a thread link opens on. A link naming a paired machine opens there or nowhere:
    /// until that machine lists the thread there is no answer yet, never another machine's
    /// thread with the same id. Only a link naming no paired machine takes any that holds it.
    static func machine(named: String?, paired: [String], holds: (String) -> Bool) -> String? {
        if let named, paired.contains(named) { return holds(named) ? named : nil }
        return paired.first(where: holds)
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
    /// The machine holding `threadId`, by `AceLink.machine`.
    func machine(holding threadId: String, named: String?) -> String? {
        AceLink.machine(named: named, paired: sessions.map(\.hostId)) { client($0)?.inbox[threadId] != nil }
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
        case "history": [.history]
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
        // Sign-in's return address is the account sheet's, not a link to open.
        guard url.scheme?.lowercased() == AceLink.scheme, !AceSignInReturn.isAccountURL(url) else { return }
        // A link opened twice before the app is ready opens once.
        if !waiting.contains(url) { waiting.append(url) }
    }
    /// Every kept link, oldest first, once the app is unlocked and a machine's runtime can read
    /// them. With no machine paired at all, settings and New thread links open anyway (New thread
    /// then asks to pair first); thread links wait for a machine.
    mutating func take(unlocked: Bool, machinesReady: Bool, noMachines: Bool = false) -> [URL] {
        guard unlocked, !waiting.isEmpty else { return [] }
        if machinesReady { defer { waiting = [] }; return waiting }
        guard noMachines else { return [] }
        let now = waiting.filter { OpenedLink.withoutMachine($0) != nil }
        waiting.removeAll { now.contains($0) }
        return now
    }
}

extension OpenedLink {
    /// The links that need no machine, read without one: `ace://settings[/<page>]`, `ace://new`
    /// and `ace://inbox` (the Open inbox intent and quick action). Every other link waits for a
    /// machine's runtime and the shared reader.
    static func withoutMachine(_ url: URL) -> OpenedLink? {
        guard url.scheme?.lowercased() == AceLink.scheme else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        switch url.host?.lowercased() {
        case "settings":
            guard parts.count <= 1 else { return nil }
            let page = parts.first
            guard page.map({ $0.range(of: "^[a-z-]{1,40}$", options: .regularExpression) != nil }) ?? true else { return nil }
            return OpenedLink(kind: "settings", page: page)
        case "new": return parts.isEmpty ? OpenedLink(kind: "new-thread") : nil
        case "inbox": return parts.isEmpty ? OpenedLink(kind: "inbox") : nil
        default: return nil
        }
    }
}
