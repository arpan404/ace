import Foundation

/// One machine's settings page as the bridge describes it (`bridge/settings-page-wire.ts`):
/// sections of rows, each with its control, current value, where the value comes from and why
/// it can't change. The phone draws it as it is; titles, choices and checks stay in TypeScript.
struct SettingsPageData: Decodable, Sendable, Equatable {
    let page: String
    let title: String
    let sections: [Section]

    struct Section: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let title: String?
        let footer: String?
        let rows: [Row]
    }
    struct Choice: Decodable, Sendable, Equatable, Identifiable, Hashable { let id: String; let label: String }
    struct Source: Decodable, Sendable, Equatable { let kind: String; let label: String }
    struct Pick: Codable, Sendable, Equatable, Hashable { let key: String; let account: String }
    /// The row under a set model that puts it back, asking first when it discards more.
    struct Clear: Decodable, Sendable, Equatable {
        struct Ask: Decodable, Sendable, Equatable { let title: String; let message: String; let confirm: String }
        let label: String
        let destructive: Bool
        let ask: Ask?
    }

    enum Control: Decodable, Sendable, Equatable {
        case toggle
        case choice(segmented: Bool, choices: [Choice])
        case text(placeholder: String)
        case number
        case list(placeholder: String, add: String)
        case model(picker: String, provider: String?, label: String, account: String?, clear: Clear?)
        case link(page: String, provider: String?, label: String)

        private enum Keys: String, CodingKey { case kind, style, choices, placeholder, add, picker, provider, label, account, clear, page }
        init(from decoder: any Decoder) throws {
            let box = try decoder.container(keyedBy: Keys.self)
            switch try box.decode(String.self, forKey: .kind) {
            case "toggle": self = .toggle
            case "choice":
                self = .choice(segmented: try box.decode(String.self, forKey: .style) == "segmented",
                               choices: try box.decode([Choice].self, forKey: .choices))
            case "text": self = .text(placeholder: try box.decode(String.self, forKey: .placeholder))
            case "number": self = .number
            case "list": self = .list(placeholder: try box.decode(String.self, forKey: .placeholder), add: try box.decode(String.self, forKey: .add))
            case "model":
                self = .model(picker: try box.decode(String.self, forKey: .picker),
                              provider: try box.decodeIfPresent(String.self, forKey: .provider),
                              label: try box.decode(String.self, forKey: .label),
                              account: try box.decodeIfPresent(String.self, forKey: .account),
                              clear: try box.decodeIfPresent(Clear.self, forKey: .clear))
            case "link":
                self = .link(page: try box.decode(String.self, forKey: .page),
                             provider: try box.decodeIfPresent(String.self, forKey: .provider),
                             label: try box.decode(String.self, forKey: .label))
            case let kind: throw DecodingError.dataCorruptedError(forKey: .kind, in: box, debugDescription: "unknown control \(kind)")
            }
        }
    }

    /// The row's value in the shapes its control uses.
    enum Value: Decodable, Sendable, Equatable {
        case bool(Bool), text(String), number(Double), list([String]), pick(Pick), none
        init(from decoder: any Decoder) throws {
            let box = try decoder.singleValueContainer()
            if box.decodeNil() { self = .none }
            else if let value = try? box.decode(Bool.self) { self = .bool(value) }
            else if let value = try? box.decode(Double.self) { self = .number(value) }
            else if let value = try? box.decode(String.self) { self = .text(value) }
            else if let value = try? box.decode([String].self) { self = .list(value) }
            else if let value = try? box.decode(Pick.self) { self = .pick(value) }
            else { self = .none }
        }
        var bool: Bool { if case .bool(let on) = self { on } else { false } }
        var text: String {
            switch self {
            case .text(let words): words
            case .number(let number): number.rounded() == number ? String(Int(number)) : String(number)
            default: ""
            }
        }
        var list: [String] { if case .list(let entries) = self { entries } else { [] } }
        var pick: Pick? { if case .pick(let pick) = self { pick } else { nil } }
    }

    struct Row: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let key: String?
        let title: String
        let control: Control
        let value: Value
        let note: String?
        let source: Source?
        let locked: String?
        let empty: String?
        private enum Keys: String, CodingKey { case id, key, title, control, value, note, source, locked, empty }
        init(from decoder: any Decoder) throws {
            let box = try decoder.container(keyedBy: Keys.self)
            id = try box.decode(String.self, forKey: .id)
            key = try box.decodeIfPresent(String.self, forKey: .key)
            title = try box.decode(String.self, forKey: .title)
            control = try box.decode(Control.self, forKey: .control)
            value = try box.decodeIfPresent(Value.self, forKey: .value) ?? .none
            note = try box.decodeIfPresent(String.self, forKey: .note)
            source = try box.decodeIfPresent(Source.self, forKey: .source)
            locked = try box.decodeIfPresent(String.self, forKey: .locked)
            empty = try box.decodeIfPresent(String.self, forKey: .empty)
        }
        /// What the row shows as its value, for comparing machines and for links.
        var shown: String {
            switch control {
            case .choice(_, let choices): choices.first { $0.id == value.text }?.label ?? value.text
            case .toggle: value.bool ? "On" : "Off"
            case .model(_, _, let label, _, _), .link(_, _, let label): label
            case .list: value.list.joined(separator: ", ")
            default: value.text
            }
        }
    }

    func row(_ id: String) -> Row? { sections.lazy.flatMap(\.rows).first { $0.id == id } }

    static func request(_ page: String) -> [String: Any] { ["type": "settings.page", "page": page] }
}

/// A change on a page, as one machine answered it.
struct SettingsPageWrite: Decodable, Sendable {
    let ok: Bool
    let message: String?
    let page: SettingsPageData?
}

/// A page read that the machine refused (an older ace without the page).
struct SettingsPageRefusal: Decodable, Sendable { let ok: Bool; let message: String }

/// What a value sent to `settings.page.set` looks like on the wire.
enum SettingsPageInput: Sendable, Equatable {
    case bool(Bool), choice(String), text(String), number(Double), list([String]), pick(SettingsPageData.Pick?)
    var wire: Any {
        switch self {
        case .bool(let on): on
        case .choice(let id): id
        case .text(let words): words
        case .number(let number): number
        case .list(let entries): entries
        case .pick(let pick): pick.map { ["key": $0.key, "account": $0.account] as [String: Any] } ?? NSNull()
        }
    }
}
