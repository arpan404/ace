import Foundation
import Observation

/// JSON the bridge hands over and Swift only hands back: a picked row's reference.
enum BridgeJSON: Codable, Hashable, Sendable {
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
    func encode(to encoder: any Encoder) throws {
        var box = encoder.singleValueContainer()
        switch self {
        case .string(let value): try box.encode(value)
        case .number(let value): try box.encode(value)
        case .bool(let value): try box.encode(value)
        case .null: try box.encodeNil()
        case .array(let values): try box.encode(values)
        case .object(let values): try box.encode(values)
        }
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

    /// The longest word completed, in UTF-16 units: the bridge reads queries up to this long.
    static let longest = 256

    static func at(_ text: String, caret: Int) -> ComposerTrigger? {
        guard caret >= 0, caret <= text.utf16.count else { return nil }
        let scalars = text.unicodeScalars
        let end = String.Index(utf16Offset: caret, in: text)
        // Step back a whole scalar at a time, as the web reads the word, so an emoji before `@`
        // keeps it part of the word.
        var start = end
        while start > scalars.startIndex {
            let before = scalars.index(before: start)
            if CharacterSet.whitespacesAndNewlines.contains(scalars[before]) { break }
            start = before
            if caret - start.utf16Offset(in: text) > longest { return nil }
        }
        let word = String(scalars[start..<end])
        guard let first = word.first else { return nil }
        let rest = word.dropFirst()
        let offset = start.utf16Offset(in: text)
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

/// One reference picked into a message: where its words stand (UTF-16 offsets) and what they
/// point at.
struct ComposerPick: Codable, Equatable, Sendable {
    var start: Int
    var end: Int
    let label: String
    let reference: BridgeJSON
}

extension ComposerPick {
    /// A file mentioned from Files: `@path` as `Mention.insert` just ended `text` with it.
    static func file(_ path: String, endingAt text: String) -> ComposerPick {
        let label = "@\(path)"
        let length = (label as NSString).length
        let end = (text as NSString).length - 1
        return ComposerPick(start: end - length, end: end, label: label,
                            reference: .object(["label": .string(label), "file": .object(["path": .string(path)])]))
    }
}

/// The references picked into one composer's message, kept with its draft. Each edit moves the
/// picks after it and drops any it touched, as `editComposerTokens` in `@ace/ui-core` does on the
/// web, so a deleted pick never comes back; the bridge sends only those still standing where they
/// are (`composer-references.ts`).
struct ComposerPicks: Codable, Equatable, Sendable {
    static let limit = 64
    private(set) var picks: [ComposerPick] = []
    var isEmpty: Bool { picks.isEmpty }

    /// Add a pick; one overlapping it is replaced, and past the per-message limit none is added.
    mutating func add(_ pick: ComposerPick) {
        picks.removeAll { $0.start < pick.end && pick.start < $0.end }
        guard picks.count < Self.limit else { return }
        picks.append(pick)
        picks.sort { $0.start < $1.start }
    }
    mutating func clear() { picks = [] }

    /// The words went from `before` to `after`: picks before the change stay, those after it move
    /// by its length, and those it touched go.
    mutating func edited(from before: String, to after: String) {
        guard !picks.isEmpty, before != after else { return }
        let old = Array(before.utf16), new = Array(after.utf16)
        var start = 0
        while start < old.count, start < new.count, old[start] == new[start] { start += 1 }
        var end = old.count, nextEnd = new.count
        while end > start, nextEnd > start, old[end - 1] == new[nextEnd - 1] { end -= 1; nextEnd -= 1 }
        let delta = nextEnd - end
        picks = picks.compactMap { pick in
            if pick.end <= start { return pick }
            guard pick.start >= end else { return nil }
            var moved = pick
            moved.start += delta
            moved.end += delta
            return moved
        }
    }

    /// What `send` carries: each reference with its place in the words.
    var payload: [Any] {
        picks.compactMap { pick in
            guard case .object(var reference) = pick.reference else { return nil }
            reference["label"] = .string(pick.label)
            reference["start"] = .number(Double(pick.start))
            reference["end"] = .number(Double(pick.end))
            return BridgeJSON.object(reference).any
        }
    }
    /// What the message holds, for the per-message limits.
    var held: [String: Int] {
        ["all": picks.count, "threads": picks.filter { $0.reference["thread"] != nil }.count,
         "tabs": picks.filter { $0.reference["browserTab"] != nil }.count]
    }
}
