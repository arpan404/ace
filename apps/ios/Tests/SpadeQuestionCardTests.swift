import Foundation
import SwiftUI
import UIKit
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
        let both = empty.typing("1,23", on: "en-US").typing("4", on: "de-DE")
        #expect(both.payload["unread"] as? Bool == true)
        // Cleared and typed again on one keyboard, it is read again.
        let again = both.replacingAll(with: "", on: "de-DE").typing("1,5", on: "de-DE")
        #expect(again.payload["text"] as? String == "1.5")
        // An edit whose keyboard isn't known keeps the one the number has.
        let unknown = SpadeQuestionCard.Draft.number("1,5", language: "de-DE").typing("5", on: nil)
        #expect(unknown.payload["text"] as? String == "1.55")
        // Begun where the keyboard wasn't known and finished on a known one: unread.
        let late = empty.typing("1,2", on: nil).typing("5", on: "de-DE")
        #expect(late.payload["unread"] as? Bool == true)
        // Select All and paste on a known keyboard replaces it: read on that keyboard alone.
        let pasted = empty.typing("12", on: nil).replacingAll(with: "1,5", on: "de-DE")
        #expect(pasted.payload["text"] as? String == "1.5")
        let mixedThenPasted = both.replacingAll(with: "2,5", on: "de-DE")
        #expect(mixedThenPasted.payload["text"] as? String == "2.5")
    }

    @Test func aPasteOverTheWholeNumberStartsItOverEvenWhenItSharesTheOldStart() {
        // #2297: `1,2` typed where the keyboard wasn't known, then `1,5` pasted over all of it on
        // a German keyboard. The old comma is gone, though both read `1,` at the start.
        let typed = SpadeQuestionCard.Draft.number("", language: nil).typing("1,2", on: nil)
        let pasted = typed.replacingAll(with: "1,5", on: "de-DE")
        #expect(pasted.payload["text"] as? String == "1.5")
        #expect(pasted.payload["unread"] == nil)
    }

    @Test func aPasteOverPartOfTheNumberKeepsTheRestsKeyboard() {
        let typed = SpadeQuestionCard.Draft.number("", language: nil).typing("1,2", on: "en-US")
        // Only the `2` replaced on a German keyboard: the English comma stays, so it is unread.
        let pasted = typed.editingNumber(replacing: NSRange(location: 2, length: 1), with: "5", on: "de-DE")
        #expect(pasted.payload["unread"] as? Bool == true)
        #expect(pasted.payload["text"] as? String == "1,5")
        // Only the `1` replaced: the comma kept is still English, so `5,2` stays unread too.
        let front = typed.editingNumber(replacing: NSRange(location: 0, length: 1), with: "5", on: "de-DE")
        #expect(front.payload["unread"] as? Bool == true)
    }

    @Test func anEditWithoutAKnownRangeNeverReadsAMarkOnOneKeyboard() {
        let typed = SpadeQuestionCard.Draft.number("1,5", language: "de-DE")
        // Undo puts `1,25` back without saying what it replaced.
        #expect(typed.changingNumber(to: "1,25").payload["unread"] as? Bool == true)
        #expect(typed.changingNumber(to: "125").payload["text"] as? String == "125")
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

private extension SpadeQuestionCard.Draft {
    /// `string` typed at the end of the number.
    func typing(_ string: String, on language: String?) -> Self {
        guard case let .number(typed, _, _) = self else { return self }
        return editingNumber(replacing: NSRange(location: typed.utf16.count, length: 0), with: string, on: language)
    }

    /// Select All, then `string` pasted (or Delete, for none).
    func replacingAll(with string: String, on language: String?) -> Self {
        guard case let .number(typed, _, _) = self else { return self }
        return editingNumber(replacing: NSRange(location: 0, length: typed.utf16.count), with: string, on: language)
    }
}

/// The number field as UIKit drives it: each edit's range reported first, then the text changed.
@MainActor @Suite struct SpadeNumberFieldTests {
    /// The draft the field edits, kept where a binding can reach it.
    final class Box { var draft = SpadeQuestionCard.Draft.number("", language: nil) }

    private func field(_ box: Box, on keyboard: @escaping () -> String?) -> (UITextField, SpadeNumberField.Coordinator) {
        let coordinator = SpadeNumberField.Coordinator(draft: Binding(get: { box.draft }, set: { box.draft = $0 }),
                                                       language: { _ in keyboard() })
        let field = UITextField()
        field.delegate = coordinator
        return (field, coordinator)
    }

    /// What UIKit does for one edit: asks the delegate, applies it, then sends `.editingChanged`.
    private func edit(_ field: UITextField, _ coordinator: SpadeNumberField.Coordinator, replacing range: NSRange, with string: String) {
        let old = (field.text ?? "") as NSString
        guard coordinator.textField(field, shouldChangeCharactersIn: range, replacementString: string) else { return }
        field.text = old.replacingCharacters(in: range, with: string)
        coordinator.changed(field)
    }

    @Test func aPasteOverTheWholeNumberOnAGermanKeyboardIsReadOnThatKeyboard() {
        let box = Box()
        var keyboard: String?
        let (field, coordinator) = self.field(box) { keyboard }
        for (at, character) in "1,2".enumerated() {
            edit(field, coordinator, replacing: NSRange(location: at, length: 0), with: String(character))
        }
        keyboard = "de-DE"
        edit(field, coordinator, replacing: NSRange(location: 0, length: 3), with: "1,5")
        #expect(box.draft.payload["text"] as? String == "1.5")
        #expect(box.draft.payload["unread"] == nil)
    }

    @Test func aChangeTheFieldDidNotReportIsNeverReadOnOneKeyboard() {
        let box = Box()
        let (field, coordinator) = self.field(box) { "de-DE" }
        edit(field, coordinator, replacing: NSRange(location: 0, length: 0), with: "1,5")
        // Undo puts other text back without asking the delegate first.
        field.text = "1,25"
        coordinator.changed(field)
        #expect(box.draft.payload["unread"] as? Bool == true)
        #expect(box.draft.payload["text"] as? String == "1,25")
    }
}
