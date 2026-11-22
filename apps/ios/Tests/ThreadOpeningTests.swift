import Testing
@testable import Ace

/// What a thread says while it opens: never a blank page, the machine named while it connects,
/// the reason and Retry when it can't, and kept rows marked as syncing until fresh ones land.
@Suite struct ThreadOpeningTests {
    private func facts(loaded: Bool = false, rows: Int = 0, connection: String = "ready",
                       problem: String? = nil, machine: String? = "Studio") -> ThreadOpening.Facts {
        ThreadOpening.Facts(loaded: loaded, rows: rows, connection: connection, problem: problem, machine: machine)
    }

    @Test func aThreadWithNothingYetOnAConnectedMachineSaysItIsLoading() {
        let opening = ThreadOpening.of(facts())
        #expect(opening == .loading)
        #expect(opening.words == "Loading…")
        #expect(opening.coversRows)
    }

    @Test func aThreadOpenedBeforeItsMachineConnectsNamesTheMachine() {
        for state in ["starting", "connecting"] {
            let opening = ThreadOpening.of(facts(connection: state))
            #expect(opening == .connecting(machine: "Studio"))
            #expect(opening.words == "Connecting to Studio…")
        }
        #expect(ThreadOpening.of(facts(connection: "connecting", machine: nil)).words == "Connecting to your computer…")
        #expect(ThreadOpening.of(facts(connection: "connecting", machine: "")).words == "Connecting to your computer…")
    }

    @Test func aConnectionThatFailedGivesItsReasonAndRetry() {
        let opening = ThreadOpening.of(facts(connection: "reconnecting", problem: "Studio isn't reachable."))
        #expect(opening == .failed(reason: "Studio isn't reachable."))
        #expect(opening.words == "Studio isn't reachable.")
        #expect(opening.retries)
        #expect(opening.coversRows)
    }

    @Test func aStateWithoutAProblemStillReadsAsConnecting() {
        // The SDK retries an unreachable machine on its own; until it says why, it is connecting.
        #expect(ThreadOpening.of(facts(connection: "reconnecting")) == .connecting(machine: "Studio"))
    }

    @Test func aProblemLeftFromAnEarlierStateIsIgnoredOnceConnected() {
        #expect(ThreadOpening.of(facts(connection: "ready", problem: "Studio isn't reachable.")) == .loading)
    }

    @Test func keptRowsShowAtOnceMarkedSyncingWhileTheMachineConnects() {
        let opening = ThreadOpening.of(facts(loaded: true, rows: 12, connection: "connecting"))
        #expect(opening == .syncing(machine: "Studio"))
        #expect(!opening.coversRows, "the kept rows stay on screen")
        #expect(opening.words == "Connecting to Studio…")
        #expect(!opening.retries)
    }

    @Test func keptRowsOnAMachineThatFailedGiveTheReasonAndRetryOverThem() {
        let opening = ThreadOpening.of(facts(loaded: true, rows: 12, connection: "offline", problem: "This phone is offline."))
        #expect(opening == .syncFailed(reason: "This phone is offline."))
        #expect(!opening.coversRows)
        #expect(opening.retries)
    }

    @Test func freshRowsOnAConnectedMachineAddNothing() {
        let opening = ThreadOpening.of(facts(loaded: true, rows: 12, connection: "ready"))
        #expect(opening == .none)
        #expect(opening.words == nil)
        #expect(!opening.coversRows)
    }

    @Test func goingFromKeptRowsToFreshOnesNeverCoversTheRows() {
        // Kept rows, connecting, then connected with the fresh window: the rows stay drawn in each
        // step, so what is on screen is updated in place rather than replaced by a placeholder.
        let steps = [facts(loaded: true, rows: 12, connection: "starting"),
                     facts(loaded: true, rows: 12, connection: "connecting"),
                     facts(loaded: true, rows: 40, connection: "ready")]
        #expect(steps.map { ThreadOpening.of($0).coversRows } == [false, false, false])
    }

    @Test func aThreadThatIsEmptyOnAMachineNotYetConnectedIsNotLeftBlank() {
        #expect(ThreadOpening.of(facts(loaded: true, rows: 0, connection: "connecting")) == .connecting(machine: "Studio"))
        #expect(ThreadOpening.of(facts(loaded: true, rows: 0, connection: "ready")) == .none)
    }
}
