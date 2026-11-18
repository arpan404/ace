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

    @Test func aNumberTypedOnADecimalCommaKeypadIsSentWithAPoint() {
        let nights = SpadeQuestionCard.Question(prompt: "How many nights?", kind: "number", placeholder: nil, options: [],
                                                other: false, most: nil, unit: "nights", time: false)
        let german = Locale(identifier: "de_DE")
        #expect(SpadeQuestionCard.Draft.field("1,5").payload(for: nights, in: german)["text"] as? String == "1.5")
        #expect(SpadeQuestionCard.Draft.field("1.5").payload(for: nights, in: Locale(identifier: "en_US"))["text"] as? String == "1.5")
        // Not a number in that locale: sent as typed, so the shared rules say why.
        #expect(SpadeQuestionCard.Draft.field("lots").payload(for: nights, in: german)["text"] as? String == "lots")
    }
}
