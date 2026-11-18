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

    /// What one question's inputs hold, sent as the bridge's `SpadeDraftWire`.
    enum Draft: Equatable, Sendable {
        case text(String)
        case picks([String], other: String)
        case confirm(Bool?)
        /// A date's text.
        case field(String)
        /// A number as typed, with the language of the keyboard it was typed on
        /// (`UITextInputMode.primaryLanguage`, nil when not known).
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
        /// keyboard is `1.5`); one that isn't a plain number in its keyboard's locale goes as
        /// typed and `unread`, so the shared rules ask again rather than guess.
        var payload: [String: Any] {
            switch self {
            case let .text(text): ["kind": "text", "text": text]
            case let .picks(picked, other): ["kind": "picks", "picked": picked, "other": other]
            case let .confirm(value): value.map { ["kind": "confirm", "value": $0] } ?? ["kind": "confirm"]
            case let .field(text): ["kind": "field", "text": text]
            case let .number(typed, language):
                if let text = SpadeQuestionCard.numberText(typed, language: language, fallback: .current) {
                    ["kind": "field", "text": text]
                } else {
                    ["kind": "field", "text": typed, "unread": true]
                }
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

    /// A number typed on a keyboard of `language` (else in `fallback`), with a point for its
    /// decimal mark as Spade reads numbers, or nil when it isn't a plain number there: a grouping
    /// mark (`1,500`, `1.500`) could mean either, so it is never read.
    static func numberText(_ typed: String, language: String?, fallback: Locale) -> String? {
        let keyboard = language.flatMap { ["emoji", "dictation"].contains($0) ? nil : Locale(identifier: $0) }
        let mark = (keyboard ?? fallback).decimalSeparator ?? "."
        var text = ""
        var marked = false
        for (at, each) in typed.trimmingCharacters(in: .whitespacesAndNewlines).enumerated() {
            if at == 0, each == "-" || each == "\u{2212}" {
                text.append("-")
            } else if let digit = each.wholeNumberValue, each.unicodeScalars.first?.properties.numericType == .decimal {
                text.append(String(digit))
            } else if String(each) == mark, !marked {
                text.append(".")
                marked = true
            } else {
                return nil
            }
        }
        return text.contains(where: \.isNumber) && text.last != "." ? text : nil
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
