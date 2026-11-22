import Testing
@testable import Ace

/// Turn on for your bots: one turn on at a time, a refusal's way out, and a phone without the
/// person's standing held until it is paired again.
@Suite struct MarketBotsApprovalTests {
    private static func refusal(_ code: String, _ way: MarketWay?) -> MarketRefusal {
        MarketRefusal(code: code, message: "Refused.", way: way, offline: false)
    }

    @Test func turnOnRunsOnceAtATimeAndOnlyOnline() {
        var state = MarketBotsApprovalState()
        #expect(state.canTurnOn(online: true))
        #expect(!state.canTurnOn(online: false))
        #expect(state.start())
        #expect(!state.start())
        #expect(!state.canTurnOn(online: true))
        state.turnedOn()
        #expect(state.canTurnOn(online: true))
        #expect(state.refusal == nil)
    }

    @Test func aRefusalForStandingAsksForThePersonAndKeepsTurnOnForConfirm() {
        var state = MarketBotsApprovalState()
        _ = state.start()
        state.refused(Self.refusal("reauth", .confirm))
        #expect(state.refusal?.asksForPerson == true)
        #expect(state.canTurnOn(online: true))
    }

    @Test func aPhoneWithoutStandingCantTurnOnUntilPairedAgain() {
        var state = MarketBotsApprovalState()
        _ = state.start()
        state.refused(Self.refusal("reauth", .pairAgain))
        #expect(state.refusal?.asksForPerson == true)
        #expect(!state.canTurnOn(online: true))
    }

    @Test func aNewerVersionIsReadAgainRatherThanAskingForThePerson() {
        var state = MarketBotsApprovalState()
        _ = state.start()
        state.refused(Self.refusal("conflict", .reread))
        #expect(state.refusal?.asksForPerson == false)
        state.dismiss()
        #expect(state.refusal == nil)
        #expect(state.canTurnOn(online: true))
    }
}
