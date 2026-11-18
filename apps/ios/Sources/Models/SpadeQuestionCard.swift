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

    /// What one question's inputs hold, sent as the bridge's `SpadeDraftWire`.
    enum Draft: Equatable, Sendable {
        case text(String)
        case picks([String], other: String)
        case confirm(Bool?)
        case field(String)

        static func empty(for question: Question) -> Draft {
            switch question.kind {
            case "choice", "choices": .picks([], other: "")
            case "confirm": .confirm(nil)
            case "number", "date": .field("")
            default: .text("")
            }
        }

        /// What the card sends for `question`: a number as Spade reads one, whatever the
        /// keyboard's locale typed (`1,5` from a decimal-comma keypad is `1.5`).
        func payload(for question: Question, in locale: Locale = .current) -> [String: Any] {
            guard question.kind == "number", case let .field(typed) = self else { return payload }
            return Draft.field(SpadeQuestionCard.numberText(typed, in: locale)).payload
        }

        private var payload: [String: Any] {
            switch self {
            case let .text(text): ["kind": "text", "text": text]
            case let .picks(picked, other): ["kind": "picks", "picked": picked, "other": other]
            case let .confirm(value): value.map { ["kind": "confirm", "value": $0] } ?? ["kind": "confirm"]
            case let .field(text): ["kind": "field", "text": text]
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

    /// A number typed in `locale` with a point for its decimal mark, as Spade reads numbers.
    /// Text that isn't a number in that locale goes as typed, so the shared rules say why.
    static func numberText(_ typed: String, in locale: Locale) -> String {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        let reader = NumberFormatter()
        reader.locale = locale
        reader.numberStyle = .decimal
        reader.generatesDecimalNumbers = true
        guard !text.isEmpty, let number = reader.number(from: text) as? NSDecimalNumber else { return text }
        return number.stringValue
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
