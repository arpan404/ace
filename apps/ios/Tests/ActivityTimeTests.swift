import Foundation
import Testing
@testable import Ace

@Suite struct ActivityTimeTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)
    private let english = Locale(identifier: "en_US")

    @Test func aDaemonClockAheadOfThePhoneReadsNowRatherThanTheFuture() {
        #expect(ActivityTime.text(now.addingTimeInterval(0.3), now: now, locale: english) == "now")
        #expect(ActivityTime.text(now.addingTimeInterval(4), now: now, locale: english) == "now")
        #expect(ActivityTime.text(now.addingTimeInterval(90), now: now, locale: english) == "now")
    }
    @Test func activityThisInstantReadsNow() {
        #expect(ActivityTime.text(now, now: now, locale: english) == "now")
        #expect(ActivityTime.text(now.addingTimeInterval(-0.4), now: now, locale: english) == "now")
    }
    @Test func pastActivityReadsHowLongAgo() {
        #expect(ActivityTime.text(now.addingTimeInterval(-120), now: now, locale: english) == "2m ago")
        #expect(ActivityTime.text(now.addingTimeInterval(-3 * 3600), now: now, locale: english) == "3h ago")
    }
}
