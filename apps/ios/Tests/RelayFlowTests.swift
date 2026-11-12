import Foundation
import Testing
@testable import Ace

/// Credit flow control between the phone and the daemon (docs/relay/README.md), both ends
/// counted with the same rules the daemon's `flow-credit.ts` uses.
@Suite struct RelayFlowTests {
    /// The daemon starts (its credit precedes the welcome); the phone answers with its own start.
    private func started() -> (daemon: RelayFlow, phone: RelayFlow) {
        var daemon = RelayFlow(), phone = RelayFlow()
        let start = daemon.start()
        #expect(start == RelayFlow.creditFragment(0))
        let reply = phone.credited(RelayFlow.readCredit(start!)!)
        #expect(reply == RelayFlow.creditFragment(0))
        _ = daemon.credited(RelayFlow.readCredit(reply!)!)
        return (daemon, phone)
    }

    @Test func aPhoneThatKeepsReadingLetsTheDaemonSendWithoutEverStalling() {
        var (daemon, phone) = started()
        let full = RelaySession.chunkSize + 1
        // 64 MiB of full fragments, each read as it arrives, as the socket does.
        for _ in 0..<(64 * 1024 * 1024 / full) {
            #expect(daemon.allows(RelayFlow.cost(full)))
            daemon.spend(RelayFlow.cost(full))
            let accepted = phone.received(RelayFlow.cost(full)); #expect(accepted)
            if let credit = phone.consumed(RelayFlow.cost(full)) {
                _ = daemon.credited(RelayFlow.readCredit(credit)!)
            }
        }
    }

    @Test func theDaemonStopsAtOneWindowUntilThePhoneReturnsCredit() {
        var (daemon, phone) = started()
        let small = 10
        var sent = 0
        while daemon.allows(RelayFlow.cost(small)) {
            daemon.spend(RelayFlow.cost(small))
            let accepted = phone.received(RelayFlow.cost(small)); #expect(accepted)
            sent += 1
        }
        // Small fragments cost 4 KiB each: a 1 MiB window is 256 of them.
        #expect(sent == 256)
        var credits: [Data] = []
        for _ in 0..<sent { if let credit = phone.consumed(RelayFlow.cost(small)) { credits.append(credit) } }
        #expect(credits.count == 4)
        for credit in credits { _ = daemon.credited(RelayFlow.readCredit(credit)!) }
        #expect(daemon.allows(RelayFlow.cost(small)))
    }

    @Test func aDaemonThatSendsPastItsWindowIsCaught() {
        var (_, phone) = started()
        for _ in 0..<256 { let accepted = phone.received(RelayFlow.cost(10)); #expect(accepted) }
        let accepted = phone.received(RelayFlow.cost(10)); #expect(!accepted)
    }

    @Test func thePhonesSendsWaitForTheDaemonsCredit() {
        var (_, phone) = started()
        #expect(phone.limited)
        phone.spend(RelayFlow.window)
        #expect(!phone.allows(RelayFlow.cost(10)))
        _ = phone.credited(RelayFlow.window / 4)
        #expect(phone.allows(RelayFlow.cost(10)))
    }

    @Test func fragmentsThatArrivedBeforeTheDaemonStartedAreNotChargedOrCredited() {
        var phone = RelayFlow()
        // Before any credit: nothing is counted, and reading earns the daemon nothing.
        let accepted = phone.received(RelayFlow.window); #expect(accepted)
        _ = phone.credited(0)
        let credit = phone.consumed(RelayFlow.window)
        #expect(credit == nil)
        // From the start on, a full window is allowed again.
        for _ in 0..<256 { let accepted = phone.received(RelayFlow.cost(10)); #expect(accepted) }
    }
}
