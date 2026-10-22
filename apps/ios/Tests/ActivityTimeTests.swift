import Foundation
import Testing
@testable import Ace

@Suite struct ActivityTimeTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)
    private let english = Locale(identifier: "en_US")

    @Test func aWorkingStretchUnderAMinuteOrAheadOfThePhoneShowsNoAge() {
        #expect(ActivityTime.elapsed(since: now.addingTimeInterval(-30), now: now, locale: english) == nil)
        #expect(ActivityTime.elapsed(since: now.addingTimeInterval(5), now: now, locale: english) == nil)
    }
    @Test func aWorkingStretchReadsItsLargestWholeUnit() {
        #expect(ActivityTime.elapsed(since: now.addingTimeInterval(-12 * 60 - 50), now: now, locale: english) == "12m")
        #expect(ActivityTime.elapsed(since: now.addingTimeInterval(-3 * 3600 - 59 * 60), now: now, locale: english) == "3h")
        #expect(ActivityTime.elapsed(since: now.addingTimeInterval(-2 * 86_400 - 3600), now: now, locale: english) == "2d")
    }
    @Test func aRowAtRestReadsNowThenItsAgeThenItsDateAfterAWeek() {
        #expect(ActivityTime.age(since: now.addingTimeInterval(-20), now: now, locale: english) == "now")
        #expect(ActivityTime.age(since: now.addingTimeInterval(-9 * 60), now: now, locale: english) == "9m")
        #expect(ActivityTime.age(since: now.addingTimeInterval(-8 * 86_400), now: now, locale: english) == "Jan 4")
    }
}
