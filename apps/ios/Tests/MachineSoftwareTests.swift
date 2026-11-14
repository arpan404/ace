import Foundation
import Testing
@testable import Ace

/// Following a machine's update on its page (`MachineSoftwareFollow`): reads repeat while it runs
/// and stop at its result, a read that fails or that the restarting machine doesn't answer keeps
/// the last page and waits longer, and a page that closes stops reading.
@MainActor struct MachineSoftwareTests {
    @Test func anUpdateIsFollowedThroughItsProgressToItsResult() async {
        let script = Script([.success(.updating("Downloading 0.0.19 · 10%")), .success(.updating("Downloading 0.0.19 · 60%")), .success(.updated)])
        let follow = MachineSoftwareFollow(fetch: script.next, pause: script.wait)
        await follow.follow()
        #expect(script.reads == 3)
        #expect(follow.data?.progress == "Updated to 0.0.19")
        #expect(follow.data?.updating == false)
        #expect(script.waits == [.seconds(3), .seconds(3)])
    }

    @Test func aReadThatFailsMidUpdateKeepsThePageAndFollowingGoesOn() async {
        let script = Script([.success(.updating("Downloading 0.0.19 · 40%")), .failure(ServiceFailure(message: "The request timed out.")), .success(.updated)])
        let follow = MachineSoftwareFollow(fetch: script.next, pause: script.wait)
        var seen: [String?] = []
        script.onRead = { _ in seen.append(follow.data?.progress) }
        await follow.follow()
        #expect(seen == [nil, "Downloading 0.0.19 · 40%", "Downloading 0.0.19 · 40%"], "the failed read left the last page up")
        #expect(follow.problem == nil)
        #expect(follow.data?.progress == "Updated to 0.0.19")
        #expect(script.waits == [.seconds(3), .seconds(6)], "a failed read waits longer before the next")
    }

    @Test func whileTheMachineRestartsTheWaitBacksOffToItsLimitThenTheResultShows() async {
        let restarting = MachineSoftwareData.updating("Installing 0.0.19", reachable: false)
        let script = Script([.success(.updating("Installing 0.0.19"))] + Array(repeating: .success(restarting), count: 5) + [.success(.updated)])
        let follow = MachineSoftwareFollow(fetch: script.next, pause: script.wait)
        await follow.follow()
        #expect(script.waits == [.seconds(3), .seconds(6), .seconds(12), .seconds(15), .seconds(15), .seconds(15)])
        #expect(follow.data?.progress == "Updated to 0.0.19")
        #expect(follow.data?.reachable == true)
    }

    @Test func leavingThePageStopsReadingAndReopeningItFollowsTheUpdateToItsResult() async {
        let script = Script([.success(.updating("Downloading 0.0.19 · 20%")), .success(.updating("Downloading 0.0.19 · 80%")), .success(.updated)])
        // The page closes during its first wait: its task is cancelled.
        let left = MachineSoftwareFollow(fetch: script.next) { _ in throw CancellationError() }
        await left.follow()
        #expect(script.reads == 1)
        #expect(left.data?.updating == true)
        // Opened again: a new page reads the update where it is and follows it to the end.
        let reopened = MachineSoftwareFollow(fetch: script.next, pause: script.wait)
        await reopened.follow()
        #expect(script.reads == 3)
        #expect(reopened.data?.progress == "Updated to 0.0.19")
    }

    @Test func updateNowCarriesTheAgentsThePersonAgreedToStop() {
        #expect(MachineSoftwareData.act("now", name: "studio", access: "admin", agents: 2)["agents"] as? Int == 2)
        #expect(MachineSoftwareData.act("idle", name: "studio", access: "admin")["agents"] == nil, "waiting for idle stops no agents")
    }
}

@MainActor private final class Script {
    private var answers: [Result<MachineSoftwareData, any Error>]
    private(set) var reads = 0
    private(set) var waits: [Duration] = []
    var onRead: ((Int) -> Void)?
    init(_ answers: [Result<MachineSoftwareData, any Error>]) { self.answers = answers }
    func next() async throws -> MachineSoftwareData {
        reads += 1
        onRead?(reads)
        return try answers.removeFirst().get()
    }
    func wait(_ duration: Duration) async throws { waits.append(duration) }
}

private extension MachineSoftwareData {
    static func updating(_ progress: String, reachable: Bool = true) -> MachineSoftwareData {
        MachineSoftwareData(line: "ace 0.0.18. 0.0.19 is available.", progress: progress, progressTone: "off",
                            actions: reachable ? [Action(action: "cancel", label: "Cancel update")] : [],
                            link: nil, note: nil, confirm: nil, updating: true, reachable: reachable, problem: nil)
    }
    static var updated: MachineSoftwareData {
        MachineSoftwareData(line: "ace 0.0.19. Up to date.", progress: "Updated to 0.0.19", progressTone: "on",
                            actions: [Action(action: "check", label: "Check for updates")],
                            link: nil, note: nil, confirm: nil, updating: false, reachable: true, problem: nil)
    }
}
