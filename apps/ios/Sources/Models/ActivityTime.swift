import Foundation

/// When a row last worked, in the reader's locale. A daemon clock slightly ahead of the phone's
/// reads "now", never a moment in the future, as the shared list ages do on the web.
enum ActivityTime {
    static func text(_ at: Date, now: Date, locale: Locale = .current) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.dateTimeStyle = .named
        formatter.unitsStyle = .abbreviated
        // Under a second (or skewed ahead) is "now"; numeric styles would say "in 0 sec.".
        let elapsed = now.timeIntervalSince(at)
        return formatter.localizedString(for: elapsed < 1 ? now : at, relativeTo: now)
    }
}
