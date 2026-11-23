import Foundation
import Testing
@testable import Ace

/// Input to a bot's computer requires fresh permission, including for queued terminal keys.
@Suite @MainActor struct SpadeComputerTests {
    static func reply(mayAct: Bool) -> SpadeComputerReply {
        let state = SpadeComputerState(mayAct: mayAct, driving: false, threadId: nil, waking: false, used: [],
                                       surfaces: [], drive: [:])
        return SpadeComputerReply(ok: true, computer: state)
    }
    static let failed = SpadeComputerReply(ok: false, title: "Couldn't read the computer", message: "Try again.")

    /// A clock the test moves by hand.
    final class Clock {
        var now = ContinuousClock.now
        func pass(_ duration: Duration) { now = now.advanced(by: duration) }
    }

    @Test func inputWaitsForAFreshReadOnceTheAppComesBackOrTheConnectionChanges() async {
        let clock = Clock()
        let watch = SpadeComputerWatch(agent: "writer", now: { clock.now })
        await watch.read { Self.reply(mayAct: true) }
        #expect(watch.mayAct(connected: true))
        #expect(!watch.mayAct(connected: false))

        watch.forget()
        #expect(!watch.mayAct(connected: true))
        await watch.read { Self.reply(mayAct: true) }
        #expect(watch.mayAct(connected: true))
    }

    @Test func whatSpadeSaidLapsesOnceThePollIsOverdue() async {
        let clock = Clock()
        let watch = SpadeComputerWatch(agent: "writer", now: { clock.now })
        await watch.read { Self.reply(mayAct: true) }
        clock.pass(SpadeComputerWatch.every)
        #expect(watch.mayAct(connected: true))
        clock.pass(SpadeComputerWatch.lapse)
        #expect(!watch.mayAct(connected: true))
    }

    @Test func aFailedReadTakesPermissionAway() async {
        let watch = SpadeComputerWatch(agent: "writer")
        await watch.read { Self.reply(mayAct: true) }
        await watch.read { Self.failed }
        #expect(!watch.mayAct(connected: true))
    }

    @Test func handingBackWithNoReadAfterLeavesNoOldPermission() async {
        let watch = SpadeComputerWatch(agent: "writer")
        await watch.read { Self.reply(mayAct: true) }
        await watch.take { Self.failed }
        #expect(!watch.mayAct(connected: true))
        #expect(watch.problem != nil)
        await watch.take { Self.reply(mayAct: false) }
        #expect(!watch.mayAct(connected: true))
    }

    @Test func noInputGoesWhileAChangeOfHandsIsOnItsWay() async {
        let watch = SpadeComputerWatch(agent: "writer")
        await watch.read { Self.reply(mayAct: true) }
        var during: Bool?
        await watch.take {
            during = watch.mayAct(connected: true)
            // A poll landing now is not taken: the change's own read says what holds.
            await watch.read { Self.reply(mayAct: true) }
            during = during == true || watch.mayAct(connected: true)
            return Self.reply(mayAct: true)
        }
        #expect(during == false)
        #expect(watch.mayAct(connected: true))
    }

    @Test func aQueuedReturnNeverRunsAfterThePageClosesOrThePersonLosesTheirTurn() async {
        var permission = 0
        var sent: [[TerminalInput]] = []
        var gate: CheckedContinuation<Void, Never>?
        let keys = SpadeKeySender(allowed: { _ in true }, permission: { permission }) { batch in
            sent.append(batch)
            await withCheckedContinuation { gate = $0 }
            return nil
        }
        keys.start("s1")
        let first = keys.type([.text("ls")])
        while gate == nil { await Task.yield() }
        // Return waits behind the slow write; meanwhile the computer changes hands.
        keys.type([.key("Enter")])
        permission += 1
        gate?.resume()
        await first?.value
        #expect(sent == [[.text("ls")]])

        gate = nil
        let second = keys.type([.text("pwd")])
        while gate == nil { await Task.yield() }
        keys.type([.key("Enter")])
        keys.stop()
        gate?.resume()
        await second?.value
        #expect(sent == [[.text("ls")], [.text("pwd")]])
        keys.type([.key("Enter")])
        #expect(sent.count == 2, "nothing goes once the page stopped following")
    }

}
