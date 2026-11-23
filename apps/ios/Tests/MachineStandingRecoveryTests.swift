import Testing
@testable import Ace

/// What a machine whose standing the daemon didn't take offers, chosen by the route the verdict
/// itself came over: "Remove and pair again" discards the machine's unsent work, so it is only
/// for a socket pairing can fix.
@Suite struct MachineStandingRecoveryTests {
    private func recovery(_ standing: PairedStanding?, _ route: StandingRoute?, needsPairing: Bool = false,
                          account: Bool = false) -> StandingRecovery {
        StandingRecovery.of(standing: standing, route: route, needsPairing: needsPairing, isAccountMachine: account)
    }

    @Test func aPairedMachineOnItsDirectRouteOffersToPairAgain() {
        #expect(recovery(.missing, .direct) == .pairAgain)
    }

    @Test func aPairedMachineOnItsRelayFallbackNeverOffersToRemoveIt() {
        // The relay proves with the account's grant: pairing again can't change that.
        #expect(recovery(.missing, .relay) == .signIn)
    }

    @Test func anAccountMachineAndAProvenOrClearedStandingOfferNothingDestructive() {
        #expect(recovery(.missing, .relay, account: true) == .none)
        #expect(recovery(.proven, .direct) == .none)
        // A cleared verdict (reconnecting, or the daemon's expiry passed) is not a refusal.
        #expect(recovery(nil, nil) == .none)
        #expect(recovery(.missing, .direct, needsPairing: true) == .none)
    }
}
