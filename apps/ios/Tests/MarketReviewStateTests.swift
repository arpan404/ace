import Foundation
import Testing
@testable import Ace

/// The review sheet's state, from reviews as `bridge/market-review.ts` sends them: Install waits
/// for every page, a refusal keeps the review unless it expired, and the switches are what is sent.
@MainActor @Suite struct MarketReviewStateTests {
    /// A bot's review as the bridge sends it.
    private static func value(id: String = "review-1", type: String = "spade-bot", blocked: String? = nil,
                              personOnly: Bool = true) -> [String: Any] {
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
            "blocked": blocked.map { $0 as Any } ?? NSNull(), "items": 3, "personOnly": personOnly,
            "standingSentence": personOnly ? "Install this from your computer." as Any : NSNull(),
            "suit": NSNull(), "plugin": NSNull(), "bot": bot,
            "choices": ["bots": [], "needs": ["connector:gmail": true, "connector:calendar": false], "startRoutines": false],
        ]
    }

    private static func review(id: String = "review-1", blocked: String? = nil) throws -> MarketReview {
        try JSONDecoder().decode(MarketReview.self, from: JSONSerialization.data(withJSONObject: value(id: id, blocked: blocked)))
    }

    /// A page of `rows` files of the review with `review`'s id.
    private static func page(_ review: MarketReview, rows: Int, next: Int?) throws -> MarketReviewPage {
        let row: (Int) -> [String: Any] = { ["id": "\($0)", "kind": "file", "section": "", "title": "f\($0)", "text": NSNull(),
                                             "detail": "1 byte", "flagged": false] }
        let value: [String: Any] = ["review": Self.value(id: review.id, blocked: review.blocked),
                                    "rows": (0..<rows).map(row), "nextOffset": next ?? NSNull(), "complete": next == nil]
        return try JSONDecoder().decode(MarketReviewPage.self, from: JSONSerialization.data(withJSONObject: value))
    }

    private static let expired = MarketRefusal(code: "expired", message: "This review expired. Review it again.", way: .reread, offline: false)
    private static let busy = MarketRefusal(code: "busy", message: "Another install is running.", way: .retry, offline: false)

    @Test func installWaitsUntilEveryPageIsRead() throws {
        var state = MarketReviewState()
        let review = try Self.review()
        state.opened(review)
        #expect(!state.canInstall)
        state.read(try Self.page(review, rows: 2, next: 2), from: 0)
        #expect(!state.canInstall)
        // A page out of order doesn't count as read.
        state.read(try Self.page(review, rows: 1, next: nil), from: 5)
        #expect(!state.canInstall)
        state.read(try Self.page(review, rows: 1, next: nil), from: 2)
        #expect(state.canInstall)
        #expect(state.rows.count == 3)
    }

    @Test func aRefusalForAnotherReasonKeepsTheReviewAndItsChoices() throws {
        var state = MarketReviewState()
        let review = try Self.review()
        state.opened(review)
        state.read(try Self.page(review, rows: 1, next: nil), from: 0)
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
        state.read(try Self.page(review, rows: 1, next: nil), from: 0)
        state.setNeed("connector:gmail", false)
        #expect(state.stuck == "Inbox can't work without Gmail.")
        #expect(!state.canInstall)
    }

    @Test func aBlockedReviewNeverInstalls() throws {
        var state = MarketReviewState()
        let review = try Self.review(blocked: "It fails ace's checks.")
        state.opened(review)
        state.read(try Self.page(review, rows: 1, next: nil), from: 0)
        #expect(state.stuck == "It fails ace's checks.")
        #expect(!state.canInstall)
    }

    @Test func aBotRefusedForStandingSaysToInstallFromTheComputer() throws {
        var state = MarketReviewState()
        let review = try Self.review()
        state.opened(review)
        state.read(try Self.page(review, rows: 1, next: nil), from: 0)
        state.refused(MarketRefusal(code: "person_only", message: "The install didn't finish.", way: .confirm, offline: false))
        #expect(state.needsComputer)
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
}
