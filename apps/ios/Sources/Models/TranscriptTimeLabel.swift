import Foundation

/// When the row on top of the transcript was written, as the time pill says it while the reader
/// scrolls: "Today 3:42 PM", "Yesterday 9:10 AM", the weekday within the past week ("Mon 4:05 PM"),
/// then the date ("Nov 16, 3:42 PM"), with the year when it isn't this one.
enum TranscriptTimeLabel {
    static func text(for date: Date, now: Date, calendar: Calendar, locale: Locale) -> String {
        func format(_ template: String) -> String {
            let formatter = DateFormatter()
            formatter.locale = locale
            formatter.calendar = calendar
            formatter.timeZone = calendar.timeZone
            formatter.setLocalizedDateFormatFromTemplate(template)
            return formatter.string(from: date)
        }
        let time = format("jmm")
        if calendar.isDate(date, inSameDayAs: now) { return "Today \(time)" }
        let today = calendar.startOfDay(for: now)
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: today), calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday \(time)"
        }
        if let weekAgo = calendar.date(byAdding: .day, value: -6, to: today), date >= weekAgo, date < today {
            return "\(format("EEE")) \(time)"
        }
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        return "\(format(sameYear ? "MMMd" : "yMMMd")), \(time)"
    }

    /// The time of the row at `index` (rows oldest first, ms since 1970, 0 for none): a row with no
    /// time takes the nearest older row's. Nil when no row up to it has one.
    static func time(at index: Int, times: (Int) -> Double) -> Double? {
        var index = index
        while index >= 0 {
            let at = times(index)
            if at > 0 { return at }
            index -= 1
        }
        return nil
    }
}
