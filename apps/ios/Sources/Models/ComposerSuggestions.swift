import Foundation
import Observation

/// JSON the bridge hands over and Swift only hands back: a picked row's reference.
enum BridgeJSON: Decodable, Hashable, Sendable {
    case string(String), number(Double), bool(Bool), null
    case array([BridgeJSON]), object([String: BridgeJSON])
    init(from decoder: any Decoder) throws {
        let box = try decoder.singleValueContainer()
        if box.decodeNil() { self = .null }
        else if let value = try? box.decode(Bool.self) { self = .bool(value) }
        else if let value = try? box.decode(Double.self) { self = .number(value) }
        else if let value = try? box.decode(String.self) { self = .string(value) }
        else if let value = try? box.decode([BridgeJSON].self) { self = .array(value) }
        else { self = .object(try box.decode([String: BridgeJSON].self)) }
    }
    /// As `JSONSerialization` takes it.
    var any: Any {
        switch self {
        case .string(let value): value
        case .number(let value): value
        case .bool(let value): value
        case .null: NSNull()
        case .array(let values): values.map(\.any)
        case .object(let values): values.mapValues(\.any)
        }
    }
    subscript(key: String) -> BridgeJSON? { if case .object(let values) = self { values[key] } else { nil } }
    var text: String? { if case .string(let value) = self { value } else { nil } }
}

/// A prompt's parameter as its form asks for it.
struct SuggestionParameter: Decodable, Hashable, Sendable {
    let name: String
    let type: String
    let required: Bool
    /// Its default, as typed text.
    let value: String
}

/// One row of the composer's `@`, `/` or + list (`bridge/composer-rows.ts`).
struct SuggestionRow: Decodable, Hashable, Identifiable, Sendable {
    let id: String
    let group: String
    let label: String
    let detail: String?
    /// file, thread, tab, or the catalog kind (skill, command, builtin, ...).
    let icon: String
    /// reference, action, arguments, attachments or refused.
    let pick: String
    let notice: String?
    let action: String?
    let parameters: [SuggestionParameter]
    /// What a reference row inserts and points at, handed back on send.
    let reference: BridgeJSON?
}

/// A list as the bridge last answered it, for the composer named by `scope`.
struct SuggestionList: Decodable, Sendable, Equatable {
    let scope: String
    let seq: Int
    let list: String
    let query: String
    /// loading, ready, empty or failed.
    let state: String
    let rows: [SuggestionRow]
}

/// A prompt form's answer: the reference with its arguments, or what to fix.
struct SuggestionArguments: Decodable, Sendable, Equatable {
    let row: String
    let error: String?
    let reference: BridgeJSON?
}

/// `composer.*` patches from `bridge/composer-suggest.ts`.
enum ComposerSuggestPatch: Decodable, Sendable {
    case list(SuggestionList)
    case add(SuggestionList)
    case arguments(SuggestionArguments)
    private enum Keys: String, CodingKey { case type }
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        switch try box.decode(String.self, forKey: .type) {
        case "composer.suggestions": self = .list(try SuggestionList(from: decoder))
        case "composer.add": self = .add(try SuggestionList(from: decoder))
        case "composer.arguments": self = .arguments(try SuggestionArguments(from: decoder))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: box, debugDescription: "Unknown composer patch")
        }
    }
}

/// The machine's last `@`/`/` list, + list and prompt-form answer.
@MainActor @Observable final class ComposerSuggestModel {
    var list: SuggestionList?
    var add: SuggestionList?
    var arguments: SuggestionArguments?
    func apply(_ patch: ComposerSuggestPatch) {
        switch patch {
        case .list(let value): list = value
        case .add(let value): add = value
        case .arguments(let value): arguments = value
        }
    }
}

/// The `@file` or `/command` word at the caret, by `triggerAt` in `@ace/ui-core` (the web's rule):
/// a word starting with `@` or `/` that holds no second one.
struct ComposerTrigger: Equatable, Sendable {
    enum Kind: String, Sendable { case mention, command }
    let kind: Kind
    let query: String
    /// UTF-16 offsets of the `@` or `/` and of the caret.
    let start: Int
    let end: Int

    static func at(_ text: String, caret: Int) -> ComposerTrigger? {
        let utf16 = text.utf16
        guard caret <= utf16.count else { return nil }
        let end = utf16.index(utf16.startIndex, offsetBy: caret)
        var start = end
        // Words longer than a path are not worth completing; the scan stays bounded.
        var steps = 0
        while start > utf16.startIndex, steps < 512 {
            let before = utf16.index(before: start)
            guard let scalar = Unicode.Scalar(utf16[before]), !CharacterSet.whitespacesAndNewlines.contains(scalar) else { break }
            start = before
            steps += 1
        }
        guard let word = String(utf16[start..<end]), let first = word.first else { return nil }
        let rest = word.dropFirst()
        let offset = utf16.distance(from: utf16.startIndex, to: start)
        if first == "@", !rest.contains("@") { return .init(kind: .mention, query: String(rest), start: offset, end: caret) }
        if first == "/", !rest.contains("/") { return .init(kind: .command, query: String(rest), start: offset, end: caret) }
        return nil
    }

    /// The word replaced by `insert` and one space (unless one follows), with the caret after it,
    /// as the web's `accept` does.
    func accept(_ insert: String, in text: String) -> (text: String, caret: Int) {
        let ns = text as NSString
        let after = ns.substring(from: min(end, ns.length))
        let spaced = after.hasPrefix(" ") ? insert : insert + " "
        let next = ns.substring(to: start) + spaced + after
        let caret = start + (spaced as NSString).length + (after.hasPrefix(" ") ? 1 : 0)
        return (next, caret)
    }
}

/// The references picked into one composer's message: the words each inserted and what they
/// point at. The bridge keeps those still written when the message goes (`composer-references.ts`).
struct ComposerPicks: Equatable, Sendable {
    private(set) var references: [BridgeJSON] = []
    mutating func add(_ reference: BridgeJSON) { references.append(reference) }
    mutating func clear() { references = [] }
    /// Only those whose words are still in the message; the payload `send` carries.
    func payload(for text: String) -> [Any] {
        references.filter { $0["label"]?.text.map(text.contains) ?? false }.map(\.any)
    }
    /// What the message holds, for the per-message limits.
    func held(in text: String) -> [String: Int] {
        let kept = references.filter { $0["label"]?.text.map(text.contains) ?? false }
        return ["all": kept.count, "threads": kept.filter { $0["thread"] != nil }.count, "tabs": kept.filter { $0["browserTab"] != nil }.count]
    }
}
