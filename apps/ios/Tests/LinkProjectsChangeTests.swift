import XCTest
@testable import Ace

/// Allow and Don't allow projects on a link send only once that machine said this phone may.
final class LinkProjectsChangeTests: XCTestCase {
    func testEitherChangeWaitsForASuccessfulCheckThere() {
        XCTAssertEqual(LinkProjectsChange.decide(offer: nil, allowed: true, machine: "Desk"), .say("Couldn't check Desk. Try again."))
        XCTAssertEqual(LinkProjectsChange.decide(offer: nil, allowed: false, machine: "Desk"), .say("Couldn't check Desk. Try again."))
        XCTAssertEqual(LinkProjectsChange.decide(offer: AllowProjectsOffer(offer: "allow", words: "w"), allowed: true, machine: "Desk"), .send)
        XCTAssertEqual(LinkProjectsChange.decide(offer: AllowProjectsOffer(offer: "held", words: "w"), allowed: false, machine: "Desk"), .send)
    }

    func testAPhoneThatCantChangeItThereIsToldWhyAndSendsNothing() {
        let settings = AllowProjectsOffer(offer: "settings", words: "allow them on Desk in Settings › Fleet.")
        XCTAssertEqual(LinkProjectsChange.decide(offer: settings, allowed: true, machine: "Desk"), .say(settings.words))
        XCTAssertEqual(LinkProjectsChange.decide(offer: settings, allowed: false, machine: "Desk"), .say(settings.words))
        let viewOnly = AllowProjectsOffer(offer: "viewOnly", words: "link them again")
        XCTAssertEqual(LinkProjectsChange.decide(offer: viewOnly, allowed: true, machine: "Desk"), .say(viewOnly.words))
        // Already as asked: nothing to send.
        XCTAssertEqual(LinkProjectsChange.decide(offer: AllowProjectsOffer(offer: "held", words: "w"), allowed: true, machine: "Desk"), .done)
        XCTAssertEqual(LinkProjectsChange.decide(offer: AllowProjectsOffer(offer: "allow", words: "w"), allowed: false, machine: "Desk"), .done)
    }
}
