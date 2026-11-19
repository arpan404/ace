import Foundation
import Testing
@testable import Ace

/// What a card of questions keeps as the person picks and types, and a date as Spade takes it.
@Suite struct SpadeQuestionCardTests {
    @Test func pickingOneReplacesThePickAndAnyOwnWords() {
        let draft = SpadeQuestionCard.Draft.picks([], other: "Faro").picking("Porto", many: false)
        #expect(draft == .picks(["Porto"], other: ""))
        #expect(draft.picking("Lisbon", many: false) == .picks(["Lisbon"], other: ""))
    }

    @Test func pickingSeveralTogglesEachAndOwnWordsCountAsOne() {
        let draft = SpadeQuestionCard.Draft.picks([], other: "")
            .picking("Lisbon", many: true).picking("Porto", many: true).picking("Lisbon", many: true)
            .writing("Faro", many: true)
        #expect(draft == .picks(["Porto"], other: "Faro"))
        #expect(draft.pickCount == 2)
    }

    @Test func ownWordsReplaceASinglePickUntilTheyAreCleared() {
        let draft = SpadeQuestionCard.Draft.picks(["Porto"], other: "")
        #expect(draft.writing("Faro", many: false) == .picks([], other: "Faro"))
        #expect(draft.writing("", many: false) == .picks(["Porto"], other: ""))
    }

    @Test func aDateIsSentAsADayOrWithTheTimeAndTheZonesOffset() throws {
        let zone = try #require(TimeZone(secondsFromGMT: -6 * 3600))
        // 2026-11-17 15:30 UTC is 09:30 at UTC−6.
        let date = Date(timeIntervalSince1970: 1_794_929_400)
        #expect(SpadeQuestionCard.dateText(date, time: false, in: zone) == "2026-11-17")
        #expect(SpadeQuestionCard.dateText(date, time: true, in: zone) == "2026-11-17T09:30:00-06:00")
        let east = try #require(TimeZone(secondsFromGMT: 5 * 3600 + 45 * 60))
        #expect(SpadeQuestionCard.dateText(date, time: true, in: east) == "2026-11-17T21:15:00+05:45")
    }

    @Test(arguments: [
        ("1,5", "de-DE", "1.5"),
        ("-2,25", "de-DE", "-2.25"),
        ("1.5", "en-US", "1.5"),
        ("\u{2212}20", "en-US", "-20"),
        // A comma isn't en_US's decimal mark, and a grouping mark never changes the value:
        // sent unread, so the shared rules ask again.
        ("1,5", "en-US", nil),
        ("1,500", "en-US", nil),
        ("1.500", "de-DE", nil),
        ("lots", "de-DE", nil),
    ] as [(String, String, String?)])
    func aNumberIsSentInTheKeyboardsLocaleWithAPoint(typed: String, language: String, sent: String?) {
        let payload = SpadeQuestionCard.Draft.number(typed, language: language).payload
        #expect(payload["kind"] as? String == "field")
        if let sent {
            #expect(payload["text"] as? String == sent)
            #expect(payload["unread"] == nil)
        } else {
            #expect(payload["text"] as? String == typed)
            #expect(payload["unread"] as? Bool == true)
        }
    }

    @Test func aNumberTypedAcrossTwoKeyboardsIsSentUnread() {
        let empty = SpadeQuestionCard.Draft.number("", language: nil)
        // `1,23` on an English keyboard, then `4` on a German one: neither reading is safe.
        let both = empty.typingNumber("1,23", on: "en-US").typingNumber("1,234", on: "de-DE")
        #expect(both.payload["unread"] as? Bool == true)
        // Cleared and typed again on one keyboard, it is read again.
        let again = both.typingNumber("", on: "de-DE").typingNumber("1,5", on: "de-DE")
        #expect(again.payload["text"] as? String == "1.5")
        // An edit whose keyboard isn't known keeps the one the number has.
        let unknown = SpadeQuestionCard.Draft.number("1,5", language: "de-DE").typingNumber("1,55", on: nil)
        #expect(unknown.payload["text"] as? String == "1.55")
        // Begun where the keyboard wasn't known and finished on a known one: unread.
        let late = empty.typingNumber("1,2", on: nil).typingNumber("1,25", on: "de-DE")
        #expect(late.payload["unread"] as? Bool == true)
        // Select All and paste on a known keyboard replaces it: read on that keyboard alone.
        let pasted = empty.typingNumber("12", on: nil).typingNumber("1,5", on: "de-DE")
        #expect(pasted.payload["text"] as? String == "1.5")
        let mixedThenPasted = both.typingNumber("7", on: "de-DE").typingNumber("2,5", on: "de-DE")
        #expect(mixedThenPasted.payload["text"] as? String == "2.5")
    }

    @Test func aNumberReplacedWholeStartsOverOnTheNewKeyboard() {
        let empty = SpadeQuestionCard.Draft.number("", language: nil)
        // #2297: `1,2` on an unknown keyboard, then Select All and paste `1,5` on a German one.
        // The shared `1,` isn't kept: the whole field was replaced.
        let unknown = empty.typingNumber("1,2", on: nil)
        #expect(unknown.replacingNumber(with: "1,5", on: "de-DE").payload["text"] as? String == "1.5")
        // Only the `2` changed on the German keyboard: the unknown keyboard's comma stays, so unread.
        #expect(unknown.typingNumber("1,5", on: "de-DE").payload["unread"] as? Bool == true)
        // Replacing a mixed number reads it again too.
        let both = empty.typingNumber("1,23", on: "en-US").typingNumber("1,234", on: "de-DE")
        #expect(both.replacingNumber(with: "1.5", on: "en-US").payload["text"] as? String == "1.5")
        // Replaced with nothing, it has no keyboard yet.
        #expect(both.replacingNumber(with: "", on: "de-DE") == empty)
    }

    @Test func aNumberWithoutAKnownKeyboardIsReadInTheAppsLocale() {
        #expect(SpadeQuestionCard.numberText("1,5", language: nil, fallback: Locale(identifier: "de_DE")) == "1.5")
        #expect(SpadeQuestionCard.numberText("1,5", language: "emoji", fallback: Locale(identifier: "de_DE")) == "1.5")
        #expect(SpadeQuestionCard.numberText("1,5", language: "dictation", fallback: Locale(identifier: "en_US")) == nil)
    }

    @Test func aPickedDateReadsBackFromTheDraftAsTheSameDay() throws {
        let zone = try #require(TimeZone(secondsFromGMT: -6 * 3600))
        let date = Date(timeIntervalSince1970: 1_794_929_400)
        let day = SpadeQuestionCard.dateText(date, time: false, in: zone)
        let read = try #require(SpadeQuestionCard.date(from: day, time: false, in: zone))
        #expect(SpadeQuestionCard.dateText(read, time: false, in: zone) == "2026-11-17")
        let withTime = SpadeQuestionCard.dateText(date, time: true, in: zone)
        #expect(SpadeQuestionCard.date(from: withTime, time: true, in: zone) == date)
        #expect(SpadeQuestionCard.date(from: "", time: false, in: zone) == nil)
        #expect(SpadeQuestionCard.date(from: "2026-13-40", time: false, in: zone) == nil)
    }
}
