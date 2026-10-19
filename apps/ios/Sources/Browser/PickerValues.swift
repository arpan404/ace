import Foundation

/// The page's picker values in HTML's own formats (`<input type=date>` and friends), to and from
/// the native pickers' `Date` and colour. Every value is read and written in UTC, and the native
/// pickers show UTC too, so a date never moves a day with the phone's time zone.
enum PickerValues {
    /// The calendar date kinds a native date picker answers.
    static let dateKinds: Set<String> = ["date", "time", "datetime-local", "month", "week"]

    static func date(_ value: String, kind: String) -> Date? {
        for format in formats(kind) {
            if let date = formatter(format).date(from: value) { return date }
        }
        return nil
    }
    static func string(_ date: Date, kind: String) -> String? {
        formats(kind).first.map { formatter($0).string(from: date) }
    }
    /// A `#rrggbb` colour's channels, 0–255.
    static func rgb(_ hex: String) -> (red: Int, green: Int, blue: Int)? {
        let digits = hex.hasPrefix("#") ? hex.dropFirst() : Substring(hex)
        guard digits.count == 6, let value = Int(digits, radix: 16) else { return nil }
        return (value >> 16 & 0xff, value >> 8 & 0xff, value & 0xff)
    }
    /// A colour as the page's colour input takes it; channels are clamped to 0–1.
    static func hex(red: Double, green: Double, blue: Double) -> String {
        let byte = { (channel: Double) in Int((min(max(channel, 0), 1) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", byte(red), byte(green), byte(blue))
    }

    /// Formats a kind's values come in, the one written first. A time may carry seconds.
    private static func formats(_ kind: String) -> [String] {
        switch kind {
        case "date": ["yyyy-MM-dd"]
        case "time": ["HH:mm", "HH:mm:ss", "HH:mm:ss.SSS"]
        case "datetime-local": ["yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss.SSS"]
        case "month": ["yyyy-MM"]
        // ISO weeks: the week-based year and week of year.
        case "week": ["YYYY-'W'ww"]
        default: []
        }
    }
    private static func formatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = .gmt
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .gmt
        formatter.dateFormat = format
        formatter.isLenient = false
        return formatter
    }
}
