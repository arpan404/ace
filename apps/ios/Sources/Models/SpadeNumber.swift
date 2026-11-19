import Foundation

/// How a number answer is read so a wrong number is never sent (#2297). Only characters typed
/// one at a time on an identified keyboard carry that keyboard's locale. Text that arrives any
/// other way (paste, Undo, Redo, dictation, a replaced selection) has none, and text with no
/// locale is sent only when every plausible reading gives the same number.
enum SpadeNumber {
    enum Reading: Equatable, Sendable {
        /// The number as Spade reads one: digits, a point for the decimal mark, `-` when below zero.
        case value(String)
        /// It reads as two different numbers (`1,234`: 1.234 or 1234), so it is asked again.
        case either(String, String)
        /// Not a number in any reading.
        case unreadable
    }

    /// `typed` read on `keyboard` (a `UITextInputMode.primaryLanguage`), or, with none, both
    /// ways round: `.` as the decimal mark with `,` grouping, and `,` with `.` grouping.
    static func reading(_ typed: String, keyboard: String?) -> Reading {
        if let keyboard {
            let locale = Locale(identifier: keyboard)
            return read(typed, decimal: locale.decimalSeparator ?? ".", grouping: locale.groupingSeparator).map(Reading.value) ?? .unreadable
        }
        let comma = read(typed, decimal: ",", grouping: "."), point = read(typed, decimal: ".", grouping: ",")
        switch (comma, point) {
        case let (comma?, point?) where comma != point: return .either(comma, point)
        case let (value?, _), let (nil, value?): return .value(value)
        case (nil, nil): return .unreadable
        }
    }

    /// The keyboard the number keeps after an edit from `old` to `new` made on `keyboard` (nil
    /// when not known, or for Undo and Redo): the one every character was typed on, else nil.
    /// One character added is typed; characters taken away leave the rest as it was; anything
    /// else brought in text from somewhere else.
    static func keyboard(after old: String, had: String?, editedTo new: String, on keyboard: String?) -> String? {
        let before = Array(old), after = Array(new)
        var start = 0
        while start < before.count, start < after.count, before[start] == after[start] { start += 1 }
        var end = 0
        while end < before.count - start, end < after.count - start,
              before[before.count - 1 - end] == after[after.count - 1 - end] { end += 1 }
        let removed = before.count - start - end, added = after.count - start - end
        if new.isEmpty { return nil }
        if added == 0 { return had }
        guard added == 1, removed == 0, let keyboard else { return nil }
        return old.isEmpty || had == keyboard ? keyboard : nil
    }

    /// `typed` with `decimal` as its decimal mark and `grouping` (when the locale has one) between
    /// each three digits before it, or nil when it isn't written that way.
    private static func read(_ typed: String, decimal: String, grouping: String?) -> String? {
        var text = Substring(typed.trimmingCharacters(in: .whitespacesAndNewlines))
        var sign = ""
        if let first = text.first, first == "-" || first == "\u{2212}" {
            sign = "-"
            text = text.dropFirst()
        }
        let parts = text.components(separatedBy: decimal)
        guard parts.count <= 2, let whole = parts.first else { return nil }
        let fraction = parts.count == 2 ? parts[1] : nil
        var groups = [whole]
        if let grouping, !grouping.isEmpty, grouping != decimal, whole.contains(grouping) {
            groups = whole.components(separatedBy: grouping)
            guard let lead = groups.first, (1...3).contains(lead.count),
                  groups.dropFirst().allSatisfy({ $0.count == 3 }) else { return nil }
        }
        guard let digits = plain(groups.joined()) else { return nil }
        guard let fraction else { return digits.isEmpty ? nil : sign + digits }
        guard let after = plain(fraction), !after.isEmpty else { return nil }
        return sign + digits + "." + after
    }

    /// `text`'s decimal digits as ASCII, or nil when it has anything else.
    private static func plain(_ text: String) -> String? {
        var digits = ""
        for each in text {
            guard let digit = each.wholeNumberValue, each.unicodeScalars.first?.properties.numericType == .decimal else { return nil }
            digits.append(String(digit))
        }
        return digits
    }
}
