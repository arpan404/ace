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

    /// A number's edits in order: each is the field's text after it and the keyboard it was
    /// made on (nil when not known, and for Undo and Redo).
    private func edited(_ edits: [(String, String?)]) -> SpadeQuestionCard.Draft {
        edits.reduce(SpadeQuestionCard.Draft.number("", language: nil)) { $0.editingNumber($1.0, on: $1.1) }
    }

    /// `text` typed one character at a time on `keyboard`, after `before` is in the field.
    private func typing(_ text: String, on keyboard: String?, after before: String = "") -> [(String, String?)] {
        var now = before
        return text.map { each in now.append(each); return (now, keyboard) }
    }

    private func sent(_ draft: SpadeQuestionCard.Draft) -> String? {
        draft.payload["unread"] == nil ? draft.payload["text"] as? String : nil
    }

    @Test(arguments: [
        // Typed on a known keyboard, it is read in that keyboard's locale, grouping included.
        ("1,234 typed in English", "1,234", "en-US", "1234"),
        ("1,234 typed in German", "1,234", "de-DE", "1.234"),
        ("1.500 typed in German", "1.500", "de-DE", "1500"),
        ("1,5 typed in German", "1,5", "de-DE", "1.5"),
        ("-2,25 typed in German", "-2,25", "de-DE", "-2.25"),
        ("minus sign typed in English", "\u{2212}20", "en-US", "-20"),
        ("1,5 typed in English", "1,5", "en-US", nil),
        ("misplaced grouping in English", "1,50,0", "en-US", nil),
        ("words", "lots", "de-DE", nil),
        // With no keyboard known, only a number every reading agrees on is read.
        ("1,5 with no keyboard", "1,5", nil, "1.5"),
        ("1.5 with no keyboard", "1.5", nil, "1.5"),
        ("1234 with no keyboard", "1234", nil, "1234"),
        ("1.234.567 with no keyboard", "1.234.567", nil, "1234567"),
        ("1,234 with no keyboard", "1,234", nil, nil),
        ("1.234 with no keyboard", "1.234", nil, nil),
    ] as [(String, String, String?, String?)])
    func aTypedNumberIsSentOnlyAsItCanBeRead(_ name: String, typed: String, keyboard: String?, sent expected: String?) {
        let draft = edited(typing(typed, on: keyboard))
        #expect(sent(draft) == expected, "\(name)")
        if expected == nil { #expect(draft.payload["text"] as? String == typed, "\(name)") }
    }

    @Test func textThatWasNotTypedHasNoKeyboardSoOnlyAnAgreedReadingIsSent() {
        // #2297: `1,2` on an unknown keyboard, then Select All and paste `1,5` on a German one.
        #expect(sent(edited(typing("1,2", on: nil) + [("1,5", "de-DE")])) == "1.5")
        // `1,234` in English, replaced by `2,5` in German, then Undo brings the English back.
        let replaced = typing("1,234", on: "en-US") + [("2", "de-DE")] + typing(",5", on: "de-DE", after: "2")
        #expect(sent(edited(replaced + [("1,234", nil)])) == nil)
        // Undone to empty, then Redo brings back `1,234` from the English keyboard.
        #expect(sent(edited(typing("2,5", on: "de-DE") + [("", nil), ("1,234", nil)])) == nil)
        // Cut whole in English, pasted back with a German keyboard up.
        #expect(sent(edited(typing("1,234", on: "en-US") + [("", "en-US"), ("1,234", "de-DE")])) == nil)
        // Begun in English and finished in German: neither keyboard's reading is safe.
        #expect(sent(edited(typing("1,23", on: "en-US") + typing("4", on: "de-DE", after: "1,23"))) == nil)
        // Emptied, it is typed afresh on one keyboard and read again.
        let mixed = typing("1,23", on: "en-US") + typing("4", on: "de-DE", after: "1,23")
        #expect(sent(edited(mixed + [("", "de-DE")] + typing("1,234", on: "en-US"))) == "1234")
    }

    @Test func deletingKeepsTheKeyboardTheRestWasTypedOn() {
        #expect(sent(edited(typing("1,2345", on: "de-DE") + [("1,234", "en-US")])) == "1.234")
        // `12,345` typed in English, cut to `12,34`: still English, where that isn't a number,
        // rather than read as 12.34.
        #expect(sent(edited(typing("12,345", on: "en-US") + [("12,34", "de-DE")])) == nil)
    }

    @Test func aNumberWithAMarkShowsWhatItSendsOrAsksAgain() {
        #expect(edited(typing("1,5", on: "de-DE")).numberReadback == "Sends 1.5")
        #expect(edited(typing("1,234", on: nil)).numberReadback == "Is this 1.234 or 1234? Type it again.")
        #expect(edited(typing("1234", on: nil)).numberReadback == nil)
        #expect(edited(typing("1,5", on: "en-US")).numberReadback == nil)
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
