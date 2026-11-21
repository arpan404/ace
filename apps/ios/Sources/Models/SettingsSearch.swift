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
        /// A page on ace's site, opened in the system browser.
        case web(URL)
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
        let found = items.enumerated().filter { _, item in finds(words, in: [item.title, item.place ?? ""] + item.keywords) }
        return found.sorted { a, b in
            let (first, second) = (a.element.title.lowercased().hasPrefix(text), b.element.title.lowercased().hasPrefix(text))
            return first != second ? first : a.offset < b.offset
        }
        .map(\.element)
    }

    private static func finds(_ words: [String], in fields: [String]) -> Bool {
        let haystack = fields.joined(separator: "\n").lowercased()
        return words.allSatisfy { haystack.contains($0) }
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

    /// Everything search finds on one machine: its tools' pages (Computer use, Projects, Usage…),
    /// then the settings its index describes. A tool the index already lists as a page (Agents)
    /// shows once, as the index's page. `entries` is nil until the index is read; the tools are
    /// found before it.
    static func machineSearchItems(_ entries: [SettingsIndexEntry]?, machine: String, fleet: Bool, spade: Bool) -> [SettingsResult] {
        let indexed = machineItems(entries ?? [], machine: machine, fleet: fleet)
        let pageTitles = Set(indexed.filter { $0.place == nil }.map { $0.title.lowercased() })
        let tools = toolItems(machine: machine, spade: spade).filter { !pageTitles.contains($0.title.lowercased()) }
        return tools + indexed
    }

    /// One machine's tools as pages search finds by name and the words people use for them.
    /// Spade shows only where the machine shows Spade, as Settings › Tools does.
    static func toolItems(machine: String, spade: Bool) -> [SettingsResult] {
        SettingsTool.allCases.filter { spade || $0 != .spade }.map { tool in
            SettingsResult(id: "\(machine)/tool/\(tool.rawValue)", title: tool.title, place: nil,
                           keywords: toolKeywords(tool), target: .phone(.tool(tool, machine: machine)))
        }
    }

    private static func toolKeywords(_ tool: SettingsTool) -> [String] {
        switch tool {
        case .agents: ["roles", "subagents", "models"]
        case .projects: ["folders", "workspaces", "repositories"]
        case .automations: ["schedule", "cron", "recurring"]
        case .usage: ["limits", "quota", "cost", "tokens"]
        case .skills: ["plugins", "skills", "extensions"]
        case .providers: ["claude", "codex", "cli", "models", "accounts"]
        case .spade: ["assistant", "bot"]
        case .sourceControl: ["git", "github", "forge", "branches"]
        case .prompts: ["snippets", "templates"]
        case .computer: ["computer", "screen", "control", "desktop"]
        case .devices: ["simulator", "emulator", "iphone", "android"]
        }
    }

    /// This phone's pages that `query` finds, as Search's commands (`settings:<page>`, as
    /// `bridge/palette.ts` names them), for when no machine answers: a setting finds its page,
    /// listed once, best match first. Settings itself opens with no machine too, so it leads when
    /// the words the palette finds it by match.
    static func phoneCommands(_ items: [SettingsResult], query: String) -> [PaletteAnswer.Command] {
        let pages = items.filter { $0.place == nil }
        var commands: [PaletteAnswer.Command] = []
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        if !words.isEmpty, finds(words, in: ["Settings", "preferences", "options"]) {
            commands.append(PaletteAnswer.Command(id: "settings", label: "Settings", detail: "Go to", score: 0))
        }
        for found in matches(items, query: query) {
            guard let page = pages.first(where: { $0.target == found.target }) else { continue }
            let id = "settings:" + page.id.replacingOccurrences(of: "phone/", with: "")
            guard !commands.contains(where: { $0.id == id }) else { continue }
            commands.append(PaletteAnswer.Command(id: id, label: page.title, detail: "Settings", score: 0))
        }
        return commands
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
        items += AceLegal.all.map { legal in
            SettingsResult(id: "phone/\(legal.id)", title: legal.title, place: "About", keywords: legal.keywords, target: .web(legal.url))
        }
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
