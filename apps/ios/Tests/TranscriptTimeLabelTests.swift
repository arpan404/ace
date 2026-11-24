import Foundation
import Testing
@testable import Ace

/// What the time pill says over the transcript while the reader scrolls.
@Suite struct TranscriptTimeLabelTests {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        return calendar
    }()
    private let locale = Locale(identifier: "en_US")

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }
    /// Monday 23 November 2026, 10:00 AM.
    private var now: Date { date(2026, 11, 23, 10, 0) }

    private func label(_ written: Date) -> String {
        // Newer formatters put a narrow no-break space before AM and PM.
        TranscriptTimeLabel.text(for: written, now: now, calendar: calendar, locale: locale)
            .replacingOccurrences(of: "\u{202F}", with: " ")
    }

    @Test func aRowFromTodaySaysToday() {
        #expect(label(date(2026, 11, 23, 0, 5)) == "Today 12:05 AM")
        #expect(label(date(2026, 11, 23, 9, 42)) == "Today 9:42 AM")
    }

    @Test func aRowFromYesterdaySaysYesterday() {
        #expect(label(date(2026, 11, 22, 21, 10)) == "Yesterday 9:10 PM")
        #expect(label(date(2026, 11, 22, 0, 0)) == "Yesterday 12:00 AM")
    }

    @Test func aRowFromThePastWeekSaysItsWeekday() {
        #expect(label(date(2026, 11, 20, 16, 5)) == "Fri 4:05 PM")
        #expect(label(date(2026, 11, 17, 8, 30)) == "Tue 8:30 AM")
    }

    @Test func anOlderRowThisYearSaysItsDate() {
        #expect(label(date(2026, 11, 16, 15, 42)) == "Nov 16, 3:42 PM")
        #expect(label(date(2026, 1, 2, 7, 0)) == "Jan 2, 7:00 AM")
    }

    @Test func aRowFromAnotherYearSaysTheYear() {
        #expect(label(date(2025, 12, 31, 23, 59)) == "Dec 31, 2025, 11:59 PM")
    }

    @Test func theDayFollowsTheCalendarsTimeZone() {
        // 2:30 AM on the 23rd in UTC is still the 22nd in New York.
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let written = utc.date(from: DateComponents(year: 2026, month: 11, day: 23, hour: 2, minute: 30))!
        #expect(label(written) == "Yesterday 9:30 PM")
    }

    @Test func aRowWithNoTimeTakesTheNearestOlderRowsTime() {
        let times: [Double] = [1_000, 0, 3_000, 0, 0]
        #expect(TranscriptTimeLabel.time(at: 4) { times[$0] } == 3_000)
        #expect(TranscriptTimeLabel.time(at: 2) { times[$0] } == 3_000)
        #expect(TranscriptTimeLabel.time(at: 1) { times[$0] } == 1_000)
    }

    @Test func noOlderRowWithATimeGivesNone() {
        let times: [Double] = [0, 0]
        #expect(TranscriptTimeLabel.time(at: 1) { times[$0] } == nil)
    }
}
