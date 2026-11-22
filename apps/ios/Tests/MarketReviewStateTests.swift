import Foundation
import Testing
@testable import Ace

/// The review sheet's state, from reviews as `bridge/market-review.ts` sends them: Install waits
/// for every page, a refusal keeps the review unless it expired, and the switches are what is sent.
@MainActor @Suite struct MarketReviewStateTests {
    /// A bot's review as the bridge sends it.
    private static func value(id: String = "review-1", type: String = "spade-bot", blocked: String? = nil) -> [String: Any] {
        let botValue: [String: Any] = [
            "face": ["main": false, "initial": "I", "away": false, "character": NSNull()],
            "task": "Looks after mail.", "modelWord": "Fast model", "modelWarning": NSNull(),
            "routines": [["name": "Morning sort", "when": "weekdays at 8:00"]], "brings": [],
            "needs": [
                ["key": "connector:gmail", "label": "Gmail", "line": "Reads mail. Required.", "required": true,
                 "offSentence": "Inbox can't work without Gmail."],
                ["key": "connector:calendar", "label": "Calendar", "line": "Books time. Optional.", "required": false,
                 "offSentence": NSNull()],
            ],
            "effects": [], "code": [], "update": NSNull(),
        ]
        let bot: Any = type == "spade-bot" ? botValue : NSNull()
        return [
            "id": id, "hash": String(repeating: "a", count: 64), "type": type, "name": "inbox", "title": "Inbox",
            "version": "1.0.0", "heading": "Get Inbox", "action": "Get", "pendingWord": "Getting…", "byLine": "Bot · 1.0.0",
            "publisher": NSNull(), "signed": true, "signedText": "Signed by the marketplace", "reviewed": true,
            "reviewMark": "Reviewed by ace", "reviewNote": NSNull(), "updates": NSNull(), "canDo": [], "facts": [],
            "findings": [["level": "warn", "levelWord": "Warning", "sentence": "Downloads and runs code."]],
            "blocked": blocked.map { $0 as Any } ?? NSNull(), "items": 3,
            "standingSentence": "Install this from your computer.",
            "suit": NSNull(), "plugin": NSNull(), "bot": bot,
            "choices": ["bots": [], "needs": ["connector:gmail": true, "connector:calendar": false], "startRoutines": false],
        ]
    }

    private static func review(id: String = "review-1", type: String = "spade-bot", blocked: String? = nil) throws -> MarketReview {
        try JSONDecoder().decode(MarketReview.self, from: JSONSerialization.data(withJSONObject: value(id: id, type: type, blocked: blocked)))
    }

    /// Every page fetched and the end scrolled to.
    private static func readAll(_ state: inout MarketReviewState, _ review: MarketReview) throws {
        state.read(try page(review, rows: 1, next: nil), from: 0)
        state.reachedEnd(of: review.id, shown: state.rows.count)
    }

    /// A page of `rows` files of the review with `review`'s id.
    private static func page(_ review: MarketReview, rows: Int, next: Int?) throws -> MarketReviewPage {
        let row: (Int) -> [String: Any] = { ["id": "\($0)", "kind": "file", "section": "", "title": "f\($0)", "text": NSNull(),
                                             "detail": "1 byte", "flagged": false] }
        let value: [String: Any] = ["review": Self.value(id: review.id, type: review.type, blocked: review.blocked),
                                    "rows": (0..<rows).map(row), "nextOffset": next ?? NSNull(), "complete": next == nil]
        return try JSONDecoder().decode(MarketReviewPage.self, from: JSONSerialization.data(withJSONObject: value))
    }

    private static let expired = MarketRefusal(code: "expired", message: "This review expired. Review it again.", way: .reread, offline: false)
    private static let busy = MarketRefusal(code: "busy", message: "Another install is running.", way: .retry, offline: false)

    @Test func installWaitsUntilEveryPageIsFetchedAndTheEndIsScrolledTo() throws {
        var state = MarketReviewState()
        let review = try Self.review()
        state.opened(review)
        #expect(!state.canInstall)
        state.read(try Self.page(review, rows: 2, next: 2), from: 0)
        state.reachedEnd(of: review.id, shown: 2)
        #expect(!state.canInstall)
        // A page out of order doesn't count as read.
        state.read(try Self.page(review, rows: 1, next: nil), from: 5)
        #expect(!state.canInstall)
        state.read(try Self.page(review, rows: 1, next: nil), from: 2)
        // Every page is here, but the last one hasn't been scrolled to.
        #expect(state.rows.count == 3)
        #expect(!state.canInstall)
        // A report from before the last page arrived doesn't count, nor one for another review.
        state.reachedEnd(of: review.id, shown: 2)
        state.reachedEnd(of: "review-other", shown: 3)
        #expect(!state.canInstall)
        state.reachedEnd(of: review.id, shown: 3)
        #expect(state.canInstall)
    }

    @Test func theEndIsInViewOnlyWhenTheContentsLastPointIsAboveTheFoot() {
        // 1000 points of content in a 600-point sheet whose foot covers 120.
        #expect(!MarketReviewState.atEnd(offsetY: 0, containerHeight: 600, insetBottom: 120, contentHeight: 1000))
        #expect(!MarketReviewState.atEnd(offsetY: 500, containerHeight: 600, insetBottom: 120, contentHeight: 1000))
        #expect(MarketReviewState.atEnd(offsetY: 520, containerHeight: 600, insetBottom: 120, contentHeight: 1000))
        // Content shorter than the sheet is in view whole.
        #expect(MarketReviewState.atEnd(offsetY: 0, containerHeight: 600, insetBottom: 120, contentHeight: 300))
    }

    @Test func aRefusalForAnotherReasonKeepsTheReviewAndItsChoices() throws {
        var state = MarketReviewState()
        let review = try Self.review()
        state.opened(review)
        try Self.readAll(&state, review)
        state.setNeed("connector:calendar", true)
        state.started()
        state.refused(Self.busy)
        #expect(state.review == review)
        #expect(state.need("connector:calendar"))
        #expect(state.canInstall)
    }

    @Test func anExpiredReviewIsDroppedAndItsSwitchesCarryOntoTheOneReadAgain() throws {
        var state = MarketReviewState()
        state.opened(try Self.review())
        state.setNeed("connector:calendar", true)
        state.refused(Self.expired)
        #expect(state.review == nil)
        #expect(!state.canInstall)
        state.opened(try Self.review(id: "review-2"))
        #expect(state.need("connector:calendar"))
        #expect(!state.complete)
    }

    @Test func aRequiredAppLeftOffStopsInstallWithItsSentence() throws {
        var state = MarketReviewState()
        let review = try Self.review()
        state.opened(review)
        try Self.readAll(&state, review)
        state.setNeed("connector:gmail", false)
        #expect(state.stuck == "Inbox can't work without Gmail.")
        #expect(!state.canInstall)
    }

    @Test func aBlockedReviewNeverInstalls() throws {
        var state = MarketReviewState()
        let review = try Self.review(blocked: "It fails ace's checks.")
        state.opened(review)
        try Self.readAll(&state, review)
        #expect(state.stuck == "It fails ace's checks.")
        #expect(!state.canInstall)
    }

    @Test func anyInstallRefusedForStandingOffersConfirmItsYouInPlaceOfInstall() throws {
        var state = MarketReviewState()
        // A skill with scripts can need the person's standing too, not only bots and plugins.
        let review = try Self.review(type: "spade-skill")
        state.opened(review)
        try Self.readAll(&state, review)
        state.refused(MarketRefusal(code: "reauth", message: "Sign in again to do this.", way: .confirm, offline: false))
        #expect(state.needsPerson)
        #expect(!state.canInstall)
        #expect(state.canConfirm)
        // The retry is under way: neither can be pressed again.
        state.started()
        #expect(!state.canConfirm)
    }

    @Test func aRefusedConfirmItsYouKeepsInstallOffUntilTheReviewIsReadAgain() throws {
        var state = MarketReviewState()
        let review = try Self.review(type: "spade-plugin")
        state.opened(review)
        try Self.readAll(&state, review)
        state.refused(MarketRefusal(code: "reauth", message: "Sign in again to do this.", way: .confirm, offline: false))
        state.started(confirmed: true)
        state.refused(MarketRefusal(code: "reauth", message: "Sign in again to do this.", way: nil, offline: false))
        #expect(state.exhausted)
        #expect(state.refusal?.message == "Sign in again to do this.")
        #expect(!state.canInstall)
        #expect(!state.canConfirm)
        // A review read again starts over.
        state.opened(try Self.review(id: "review-2", type: "spade-plugin"))
        #expect(!state.exhausted)
    }

        @Test func anInstallFromAPhoneWithoutStandingCanOnlyPairAgain() throws {
        var state = MarketReviewState()
        let review = try Self.review(type: "spade-plugin")
        state.opened(review)
        try Self.readAll(&state, review)
        state.refused(MarketRefusal(code: "reauth", message: "Pair this iPhone again to install here.", way: .pairAgain, offline: false))
        #expect(state.needsPerson)
        #expect(!state.canInstall)
        #expect(!state.canConfirm)
    }

    @Test func anInstallThatNeedsAPersonsGrantSaysToInstallFromTheComputer() throws {
        var state = MarketReviewState()
        let review = try Self.review()
        state.opened(review)
        try Self.readAll(&state, review)
        state.refused(MarketRefusal(code: "person_grant", message: "The install didn't finish.", way: .computer, offline: false))
        #expect(state.needsComputer)
        #expect(!state.needsPerson)
        #expect(!state.canInstall)
    }

    @Test func theSwitchesAreWhatInstallSends() throws {
        var state = MarketReviewState()
        state.opened(try Self.review())
        state.setNeed("connector:calendar", true)
        state.choices.startRoutines = true
        let sent = state.choices.payload
        #expect(sent["needs"] as? [String: Bool] == ["connector:gmail": true, "connector:calendar": true])
        #expect(sent["startRoutines"] as? Bool == true)
        #expect(sent["effects"] == nil)
    }

    @Test func aReviewReadAgainStartsItsRoutinesOff() throws {
        var state = MarketReviewState()
        state.opened(try Self.review())
        state.choices.startRoutines = true
        state.refused(Self.expired)
        state.opened(try Self.review(id: "review-2"))
        #expect(!state.choices.startRoutines)
    }
}
