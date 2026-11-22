import Testing
@testable import Ace

/// What a thread says while it opens: never a blank page, the machine named while it connects,
/// the reason and Retry when it can't, and kept rows marked as syncing until fresh ones land.
@Suite struct ThreadOpeningTests {
    private func facts(loaded: Bool = false, replacing: Bool = false, connection: String = "ready",
                       problem: String? = nil, machine: String? = "Studio") -> ThreadOpening.Facts {
        ThreadOpening.Facts(loaded: loaded, replacing: replacing, connection: connection, problem: problem, machine: machine)
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
        let opening = ThreadOpening.of(facts(loaded: true, connection: "connecting"))
        #expect(opening == .syncing(machine: "Studio"))
        #expect(!opening.coversRows, "the kept rows stay on screen")
        #expect(opening.words == "Connecting to Studio…")
        #expect(!opening.retries)
    }

    @Test func keptRowsOnAMachineThatFailedGiveTheReasonAndRetryOverThem() {
        let opening = ThreadOpening.of(facts(loaded: true, connection: "offline", problem: "This phone is offline."))
        #expect(opening == .syncFailed(reason: "This phone is offline."))
        #expect(!opening.coversRows)
        #expect(opening.retries)
    }

    @Test func freshRowsOnAConnectedMachineAddNothing() {
        let opening = ThreadOpening.of(facts(loaded: true, connection: "ready"))
        #expect(opening == .none)
        #expect(opening.words == nil)
        #expect(!opening.coversRows)
    }

    @Test func goingFromKeptRowsToFreshOnesNeverCoversTheRows() {
        // Kept rows, connecting, then connected with the fresh window: the rows stay drawn in each
        // step, so what is on screen is updated in place rather than replaced by a placeholder.
        let steps = [facts(loaded: true, connection: "starting"),
                     facts(loaded: true, connection: "connecting"),
                     facts(loaded: true, replacing: true, connection: "ready"),
                     facts(loaded: true, connection: "ready")]
        #expect(steps.map { ThreadOpening.of($0).coversRows } == [false, false, false, false])
    }

    @Test func keptRowsStayMarkedOnceConnectedUntilTheFreshCopyHasReplacedThem() {
        let staged = ThreadOpening.of(facts(loaded: true, replacing: true, connection: "ready"))
        #expect(staged == .updating, "a ready socket alone doesn't make the kept rows current")
        #expect(staged.words == "Syncing…")
        #expect(!staged.coversRows)
        #expect(ThreadOpening.of(facts(loaded: true, replacing: false, connection: "ready")) == .none)
    }

    @Test func anEmptyThreadThatWasLoadedSaysTheConnectionsStateAndRetryOnDisconnect() {
        // Its first screen had no rows: the state is still said over it, with Retry on failure.
        let connecting = ThreadOpening.of(facts(loaded: true, connection: "connecting"))
        #expect(connecting == .syncing(machine: "Studio"))
        #expect(connecting.words == "Connecting to Studio…")
        let failed = ThreadOpening.of(facts(loaded: true, connection: "reconnecting", problem: "Studio isn't reachable."))
        #expect(failed == .syncFailed(reason: "Studio isn't reachable."))
        #expect(failed.retries)
        #expect(ThreadOpening.of(facts(loaded: true, connection: "ready")) == .none)
    }

    @Test func retryAsksForTheConnectionWhileThereIsNone() {
        #expect(ThreadOpenRetry.decide(connected: false, loaded: false, hasRows: false, asked: true) == .reconnect)
    }

    @Test func retryNeverStartsASecondOpenWhileOneIsAnswering() {
        #expect(ThreadOpenRetry.decide(connected: true, loaded: false, hasRows: false, asked: true) == .nothing)
        #expect(ThreadOpenRetry.decide(connected: true, loaded: true, hasRows: false, asked: true) == .nothing)
    }

    @Test func retryDoesNothingOnceTheOpenHasSucceeded() {
        #expect(ThreadOpenRetry.decide(connected: true, loaded: true, hasRows: true, asked: false) == .nothing)
    }

    @Test func retryAsksForAThreadWithNoRowsOnceWhenNoOpenIsAnswering() {
        #expect(ThreadOpenRetry.decide(connected: true, loaded: true, hasRows: false, asked: false) == .open)
        #expect(ThreadOpenRetry.decide(connected: true, loaded: false, hasRows: false, asked: false) == .open)
    }
}
