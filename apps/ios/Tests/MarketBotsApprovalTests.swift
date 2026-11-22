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
        let started1 = state.start(confirmed: false)
        #expect(started1)
        let started2 = state.start(confirmed: false)
        #expect(!started2)
        #expect(!state.canTurnOn(online: true))
        state.turnedOn()
        #expect(state.canTurnOn(online: true))
        #expect(state.refusal == nil)
    }

    @Test func aRefusalForStandingAsksForThePersonAndKeepsTurnOnForConfirm() {
        var state = MarketBotsApprovalState()
        _ = state.start(confirmed: false)
        state.refused(Self.refusal("reauth", .confirm))
        #expect(state.refusal?.asksForPerson == true)
        #expect(state.canTurnOn(online: true))
    }

    @Test func aPhoneWithoutStandingCantTurnOnUntilPairedAgain() {
        var state = MarketBotsApprovalState()
        _ = state.start(confirmed: false)
        state.refused(Self.refusal("reauth", .pairAgain))
        #expect(state.refusal?.asksForPerson == true)
        #expect(!state.canTurnOn(online: true))
    }

    @Test func aRefusedConfirmItsYouHoldsTurnOnUntilTheRowIsReadAgain() {
        var state = MarketBotsApprovalState()
        _ = state.start(confirmed: false)
        state.refused(Self.refusal("reauth", .confirm))
        let started3 = state.start(confirmed: true)
        #expect(started3)
        // The bridge sends the retry once; refused again, it offers no way.
        state.refused(Self.refusal("reauth", nil))
        #expect(state.exhausted)
        #expect(state.readsAgain)
        #expect(!state.canTurnOn(online: true))
        let started4 = state.start(confirmed: false)
        #expect(!started4)
        let started5 = state.start(confirmed: true)
        #expect(!started5)
        state.lookAgain()
        #expect(state.canTurnOn(online: true))
    }

    @Test func aNewerVersionHoldsTurnOnWhileItIsReadAndAfterTheReadFails() {
        var state = MarketBotsApprovalState()
        _ = state.start(confirmed: false)
        state.refused(Self.refusal("conflict", .reread))
        state.lookAgain()
        // Read under way, or failed and the row unchanged: its hash is still stale.
        #expect(!state.canTurnOn(online: true))
        #expect(state.readsAgain)
        state.readAgain()
        #expect(state.canTurnOn(online: true))
    }

    @Test func aTurnOnThatNeedsThePersonsGrantGoesToTheComputerWithNoRetry() {
        var state = MarketBotsApprovalState()
        _ = state.start(confirmed: false)
        state.refused(Self.refusal("person_grant", .computer))
        #expect(!state.canTurnOn(online: true))
        #expect(!state.readsAgain)
    }
}
