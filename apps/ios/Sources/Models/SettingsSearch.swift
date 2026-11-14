import Foundation
import Observation

/// One machine setting as the bridge indexes it (`bridge/settings-index.ts`): its page, section,
/// row id (the anchor its page scrolls to) and title.
struct SettingsIndexEntry: Decodable, Sendable, Equatable {
    let page: String
    let pageTitle: String
    let section: String?
    let row: String
    let title: String
}
struct SettingsIndexReply: Decodable, Sendable { let entries: [SettingsIndexEntry] }

/// Something Settings' search finds: a page or a single setting, on this phone or on a machine.
struct SettingsResult: Identifiable, Equatable {
    enum Target: Equatable {
        case phone(SettingsRoute)
        /// A machine's settings page, opened with `row` in view.
        case machine(machine: String, page: String, pageTitle: String, row: String)
    }
    let id: String
    let title: String
    /// Where it sits: "Appearance", "Agents · Roles".
    let place: String?
    /// Other words people use for it ("dark mode" for Theme).
    var keywords: [String] = []
    let target: Target
}

/// Settings' search: every query word must be found in a result's title, place or keywords, and
/// titles that start with the query come first, as the web's settings search does. Pure.
enum SettingsSearch {
    static func matches(_ items: [SettingsResult], query: String) -> [SettingsResult] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let words = text.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return [] }
        let found = items.enumerated().filter { _, item in
            let haystack = ([item.title, item.place ?? ""] + item.keywords).joined(separator: "\n").lowercased()
            return words.allSatisfy { haystack.contains($0) }
        }
        return found.sorted { a, b in
            let (first, second) = (a.element.title.lowercased().hasPrefix(text), b.element.title.lowercased().hasPrefix(text))
            return first != second ? first : a.offset < b.offset
        }
        .map(\.element)
    }

    /// One machine's settings as results, its pages first. `fleet` is shown only while the
    /// machine links to another, as its detail page does.
    static func machineItems(_ entries: [SettingsIndexEntry], machine: String, fleet: Bool) -> [SettingsResult] {
        let shown = entries.filter { fleet || $0.page != "fleet" }
        var pages: [SettingsResult] = []
        for entry in shown where !pages.contains(where: { $0.id == "\(machine)/\(entry.page)" }) {
            pages.append(SettingsResult(id: "\(machine)/\(entry.page)", title: entry.pageTitle, place: nil,
                                        target: .machine(machine: machine, page: entry.page, pageTitle: entry.pageTitle, row: "")))
        }
        let rows = shown.map { entry in
            SettingsResult(id: "\(machine)/\(entry.page)/\(entry.row)", title: entry.title,
                           place: [entry.pageTitle, entry.section].compactMap { $0 }.joined(separator: " · "),
                           target: .machine(machine: machine, page: entry.page, pageTitle: entry.pageTitle, row: entry.row))
        }
        return pages + rows
    }

    /// This phone's own settings pages and the settings on them that people look for by name.
    static func phoneItems(notifications: Bool, lock: Bool) -> [SettingsResult] {
        func page(_ route: SettingsRoute, _ id: String, _ title: String, _ keywords: [String] = []) -> SettingsResult {
            SettingsResult(id: "phone/\(id)", title: title, place: nil, keywords: keywords, target: .phone(route))
        }
        func setting(_ route: SettingsRoute, _ id: String, _ title: String, on place: String, _ keywords: [String] = []) -> SettingsResult {
            SettingsResult(id: "phone/\(id)", title: title, place: place, keywords: keywords, target: .phone(route))
        }
        var items = [
            page(.account, "account", "Profile", ["account", "sign in", "avatar", "name"]),
            page(.machines, "machines", "Machines", ["computers", "devices", "paired"]),
            page(.pair, "pair", "Pair a computer", ["add", "qr", "connect"]),
        ]
        if notifications {
            items += [
                page(.notifications, "notifications", "Notifications", ["alerts", "push"]),
                setting(.notifications, "notifications.live", "Live Activity", on: "Notifications", ["lock screen", "dynamic island"]),
                setting(.notifications, "notifications.quiet", "Quiet hours", on: "Notifications", ["do not disturb", "night"]),
            ]
        }
        if lock {
            items += [
                page(.lock, "lock", "App lock", ["face id", "touch id", "passcode", "security"]),
                setting(.lock, "lock.after", "Lock after", on: "App lock", ["timeout", "face id"]),
            ]
        }
        items += [
            page(.appearance, "appearance", "Appearance", ["look"]),
            setting(.appearance, "appearance.mode", "Mode", on: "Appearance", ["dark", "light", "system"]),
            setting(.appearance, "appearance.theme", "Theme", on: "Appearance", ["colours", "colors", "dark mode"]),
            setting(.appearance, "appearance.accent", "Accent", on: "Appearance", ["colour", "color", "tint"]),
            setting(.appearance, "appearance.density", "Density", on: "Appearance", ["compact", "comfortable", "spacing"]),
            setting(.appearance, "appearance.size", "Transcript size", on: "Appearance", ["text", "font", "larger", "smaller"]),
            setting(.appearance, "appearance.motion", "Reduce motion", on: "Appearance", ["animation"]),
            setting(.appearance, "appearance.translucency", "Translucency", on: "Appearance", ["glass", "transparency"]),
            page(.keyboard, "keyboard", "Keyboard", ["shortcuts", "keys", "hardware"]),
            setting(.keyboard, "keyboard.return", "Send with Return", on: "Keyboard", ["enter", "submit"]),
            page(.history, "history", "History", ["settled", "past"]),
            page(.archive, "archive", "Archived", ["archive", "restore"]),
            page(.profiles, "profiles", "Task profiles"),
            page(.cache, "cache", "Cached chats", ["offline", "storage", "clear"]),
            page(.licences, "licences", "Licences", ["about", "open source"]),
        ]
        return items
    }
}

/// Each paired machine's settings index, read once per connection: the rows a machine describes
/// don't change while it runs.
@MainActor @Observable final class MachineSettingsIndex {
    private(set) var entries: [String: [SettingsIndexEntry]] = [:]

    func read(_ inbox: MachineInbox) async {
        for session in inbox.sessions where session.client.connection == "ready" && entries[session.hostId] == nil {
            if let reply = try? await session.client.service(["type": "settings.index"], as: SettingsIndexReply.self) {
                entries[session.hostId] = reply.entries
            }
        }
    }
}
