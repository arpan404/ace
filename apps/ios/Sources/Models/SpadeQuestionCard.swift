import Foundation

/// A bot's card of questions (ADR 0154) as the bridge put it (`bridge/spade-question-rows.ts`).
/// The rules for an answer are the bridge's: the card only keeps what the person typed or picked
/// (`Draft`) and sends it.
struct SpadeQuestionCard: Decodable, Equatable, Sendable {
    struct Option: Decodable, Equatable, Sendable {
        let label: String
        let detail: String?
    }
    struct Question: Decodable, Equatable, Sendable {
        let prompt: String
        /// `text`, `choice`, `choices`, `confirm`, `number` or `date`; anything else is asked as text.
        let kind: String
        let placeholder: String?
        let options: [Option]
        /// The person may write their own answer instead of picking.
        let other: Bool
        /// `choices`: the most it takes, for "2 of 3 picked".
        let most: Int?
        let unit: String?
        /// `number`: it may be below zero, so its keypad needs a minus sign.
        let signed: Bool
        /// `date`: the time is asked too.
        let time: Bool
    }
    /// `open`, `later` (folded to a line until opened) or `settled`.
    enum Standing: String, Decodable, Sendable { case open, later, settled }

    let callId: String
    let label: String
    let standing: Standing
    let questions: [Question]
    /// Settled with answers: each question's answer in the person's words.
    let answers: [String?]?
    /// Settled without answers: how it ended.
    let line: String?
    /// Settled only because its reply finished unanswered, not by its own answer or dismissal:
    /// it may yet turn out to be for later, so its draft and lock are kept (`SpadeCards`).
    let closed: Bool

    /// What one question's inputs hold, sent as the bridge's `SpadeDraftWire`.
    enum Draft: Equatable, Sendable {
        case text(String)
        case picks([String], other: String)
        case confirm(Bool?)
        /// A date's text.
        case field(String)
        /// A number as typed, with the language of the keyboard every character of it was typed
        /// on (`UITextInputMode.primaryLanguage`), nil when any arrived another way (`SpadeNumber`).
        case number(String, language: String?)

        static func empty(for question: Question) -> Draft {
            switch question.kind {
            case "choice", "choices": .picks([], other: "")
            case "confirm": .confirm(nil)
            case "number": .number("", language: nil)
            case "date": .field("")
            default: .text("")
            }
        }

        /// What the card sends for it. A number goes as Spade reads one (`1,5` from a German
        /// keyboard is `1.5`); one that can't be read for certain goes as typed and `unread`, so
        /// the shared rules ask again rather than guess.
        var payload: [String: Any] {
            switch self {
            case let .text(text): ["kind": "text", "text": text]
            case let .picks(picked, other): ["kind": "picks", "picked": picked, "other": other]
            case let .confirm(value): value.map { ["kind": "confirm", "value": $0] } ?? ["kind": "confirm"]
            case let .field(text): ["kind": "field", "text": text]
            case let .number(typed, language):
                if case let .value(text) = SpadeNumber.reading(typed, keyboard: language) {
                    ["kind": "field", "text": text]
                } else {
                    ["kind": "field", "text": typed, "unread": true]
                }
            }
        }

        /// The number edited to `text` on a keyboard of `language`: nil when not known, and for
        /// Undo and Redo, which bring back text from whatever keyboard it was first typed on.
        func editingNumber(_ text: String, on language: String?) -> Draft {
            guard case let .number(old, had) = self else { return .number(text, language: nil) }
            return .number(text, language: SpadeNumber.keyboard(after: old, had: had, editedTo: text, on: language))
        }

        /// Under a number with a decimal or grouping mark, what it sends (`Sends 1.5`) or, when it
        /// reads two ways, the question; nil without a mark, or when it isn't a number at all.
        var numberReadback: String? {
            guard case let .number(typed, language) = self,
                  typed.contains(where: { !$0.isNumber && !$0.isWhitespace && $0 != "-" && $0 != "\u{2212}" }) else { return nil }
            switch SpadeNumber.reading(typed, keyboard: language) {
            case let .value(text): return "Sends \(text)"
            case let .either(one, other): return "Is this \(one) or \(other)? Type it again."
            case .unreadable: return nil
            }
        }

        /// Pick `label`: the one pick for `choice`, toggled for `choices`. A single pick clears
        /// own words, as own words replace a single pick.
        func picking(_ label: String, many: Bool) -> Draft {
            guard case let .picks(picked, other) = self else { return .picks([label], other: "") }
            guard many else { return .picks([label], other: "") }
            return .picks(picked.contains(label) ? picked.filter { $0 != label } : picked + [label], other: other)
        }

        func writing(_ words: String, many: Bool) -> Draft {
            guard case let .picks(picked, _) = self else { return .picks([], other: words) }
            return .picks(many || words.isEmpty ? picked : [], other: words)
        }

        /// How many it has picked, own words counting as one.
        var pickCount: Int {
            guard case let .picks(picked, other) = self else { return 0 }
            return picked.count + (other.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : 1)
        }
    }

    /// A date question's answer read back, for the picker to show what the card will send.
    static func date(from text: String, time: Bool, in zone: TimeZone = .current) -> Date? {
        if time {
            let reader = ISO8601DateFormatter()
            reader.formatOptions = [.withInternetDateTime]
            return reader.date(from: text)
        }
        let parts = text.split(separator: "-", omittingEmptySubsequences: false).compactMap { Int($0) }
        guard parts.count == 3, text.count == 10 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let day = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        guard day.isValidDate(in: calendar) else { return nil }
        return calendar.date(from: day)
    }

    /// A date question's answer as Spade takes it: `2026-11-17`, or with the time and the zone's
    /// offset, `2026-11-17T09:30:00-06:00`.
    static func dateText(_ date: Date, time: Bool, in zone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let at = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let day = String(format: "%04d-%02d-%02d", at.year ?? 0, at.month ?? 0, at.day ?? 0)
        guard time else { return day }
        let offset = zone.secondsFromGMT(for: date) / 60
        let sign = offset < 0 ? "-" : "+"
        return day + String(format: "T%02d:%02d:00%@%02d:%02d", at.hour ?? 0, at.minute ?? 0, sign, abs(offset) / 60, abs(offset) % 60)
    }
}
