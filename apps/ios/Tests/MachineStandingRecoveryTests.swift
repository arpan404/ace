import Testing
@testable import Ace

/// What a machine whose standing the daemon didn't take offers, chosen by the route in use:
/// "Remove and pair again" discards the machine's unsent work, so it is only for a socket pairing
/// can fix.
@Suite struct MachineStandingRecoveryTests {
    @Test func aPairedMachineOnItsDirectRouteOffersToPairAgain() {
        #expect(StandingRecovery.of(standing: .missing, needsPairing: false, isAccountMachine: false, onRelay: false) == .pairAgain)
    }

    @Test func aPairedMachineOnItsRelayFallbackNeverOffersToRemoveIt() {
        // The relay proves with the account's grant: pairing again can't change that.
        #expect(StandingRecovery.of(standing: .missing, needsPairing: false, isAccountMachine: false, onRelay: true) == .signIn)
    }

    @Test func anAccountMachineAndAProvenOrUnknownStandingOfferNothingDestructive() {
        #expect(StandingRecovery.of(standing: .missing, needsPairing: false, isAccountMachine: true, onRelay: true) == .none)
        #expect(StandingRecovery.of(standing: .proven, needsPairing: false, isAccountMachine: false, onRelay: false) == .none)
        // A cleared verdict (reconnecting, or the daemon's expiry passed) is not a refusal.
        #expect(StandingRecovery.of(standing: nil, needsPairing: false, isAccountMachine: false, onRelay: false) == .none)
        #expect(StandingRecovery.of(standing: .missing, needsPairing: true, isAccountMachine: false, onRelay: false) == .none)
    }
}
