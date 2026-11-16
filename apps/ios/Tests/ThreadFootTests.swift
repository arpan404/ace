import Testing
@testable import Ace

/// The live facts show once: on the pill while it is on screen and names them, else in the
/// transcript. A live tree or command never leaves view.
@Suite struct ThreadFootTests {
    private func pill(subagents: Bool = true, commands: Bool = true) -> PillRow {
        PillRow(status: PillRow.Status(label: "Waiting on 2", lead: "", since: nil, code: "", live: false, tone: "working", opens: "agents"),
                segments: [PillRow.Segment(kind: "commands", label: "1 command", opens: "agents", live: false)],
                covers: PillRow.Covers(subagents: subagents, commands: commands))
    }

    /// The foot as the page leaves it with room for every part: each of the pill's parts is on
    /// screen exactly when the page draws the pill, and says so (`ComposerLivePills.onScreen`).
    private func drawn(_ foot: ThreadFoot) -> ThreadFoot {
        var drawn = foot
        drawn.visiblePills = foot.drawsPill ? Set((foot.pill.map(LivePill.of) ?? []).map(\.id)) : []
        return drawn
    }

    @Test func aLiveTreeTheShownPillNamesLeavesTheTranscriptToThePill() {
        let named = drawn(ThreadFoot(pill: pill())).named
        #expect(!named.transcriptShows(.subagents, live: true))
        #expect(!named.transcriptShows(.commands, live: true))
    }

    @Test func aSettledRowAlwaysShowsAsTheRecord() {
        let named = drawn(ThreadFoot(pill: pill())).named
        #expect(named.transcriptShows(.subagents, live: false))
        #expect(named.transcriptShows(.commands, live: false))
    }

    @Test func aLiveFactThePillDoesNotNameStaysInTheTranscript() {
        let named = drawn(ThreadFoot(pill: pill(subagents: true, commands: false))).named
        #expect(!named.transcriptShows(.subagents, live: true))
        #expect(named.transcriptShows(.commands, live: true))
    }

    @Test func theSuggestionListTakesThePillsPlaceAndTheLiveRowsShowWhileItIsOpen() {
        // Live subagents and a command, and the person types `@` or `/`.
        let foot = drawn(ThreadFoot(pill: pill(), suggesting: true))
        #expect(!foot.drawsPill)
        #expect(foot.named.transcriptShows(.subagents, live: true))
        #expect(foot.named.transcriptShows(.commands, live: true))
        // The list closes: the pill is back and says them again.
        let closed = drawn(ThreadFoot(pill: pill(), suggesting: false))
        #expect(!closed.named.transcriptShows(.subagents, live: true))
    }

    @Test func aPillNotOnScreenForAnyReasonNamesNothing() {
        // The bridge sent a pill but it hasn't said it's on screen (not drawn yet, gone for a
        // reason the foot doesn't list): the transcript keeps every live row.
        let foot = ThreadFoot(pill: pill(), visiblePills: [])
        #expect(foot.drawsPill)
        #expect(foot.named.transcriptShows(.subagents, live: true))
        #expect(foot.named.transcriptShows(.commands, live: true))
    }

    @Test func aPartScrolledOffTheRowLeavesItsFactsRowsInTheTranscript() {
        // Large text: "Waiting on 2" shows, "1 command" is past the row's edge.
        let foot = ThreadFoot(pill: pill(), visiblePills: ["status"])
        #expect(!foot.named.transcriptShows(.subagents, live: true))
        #expect(foot.named.transcriptShows(.commands, live: true))
        // Scrolled along: the command's part shows and the status is off.
        let along = ThreadFoot(pill: pill(), visiblePills: ["commands"])
        #expect(along.named.transcriptShows(.subagents, live: true))
        #expect(!along.named.transcriptShows(.commands, live: true))
    }

    @Test func aFactIsSaidByItsOwnSegmentElseByTheStatus() {
        // "Waiting on 2" says the subagents; "1 command" says the command.
        #expect(pill().part(naming: .subagents) == "status")
        #expect(pill().part(naming: .commands) == "commands")
        // Beside a working root each has its own segment.
        let working = PillRow(status: PillRow.Status(label: "Working", lead: "Working for", since: 1, code: "", live: true, tone: "working", opens: ""),
                              segments: [PillRow.Segment(kind: "subagents", label: "2 subagents", opens: "agents", live: false)],
                              covers: PillRow.Covers(subagents: true, commands: false))
        #expect(working.part(naming: .subagents) == "subagents")
        // Only the status shows: the subagents segment is off the row, so their rows stay.
        #expect(ThreadFoot(pill: working, visiblePills: ["status"]).named.transcriptShows(.subagents, live: true))
    }

    @Test(arguments: [
        ThreadFoot(requests: true), ThreadFoot(hold: true), ThreadFoot(notSent: true),
        ThreadFoot(leftRunning: true), ThreadFoot(transfer: true), ThreadFoot(work: true),
    ])
    func anyStripTakesThePillsPlaceAndBringsTheLiveRowsBack(_ strip: ThreadFoot) {
        var foot = strip
        foot.pill = pill()
        #expect(!foot.drawsPill)
        #expect(drawn(foot).named.transcriptShows(.subagents, live: true))
        // A report left over from before the strip came can't hide a row either.
        foot.visiblePills = ["status", "commands"]
        #expect(foot.named.transcriptShows(.subagents, live: true))
        #expect(foot.named.transcriptShows(.commands, live: true))
    }

    @Test func withNoPillOrAnOlderBridgesPillTheTranscriptKeepsEveryLiveRow() {
        #expect(drawn(ThreadFoot()).named.transcriptShows(.subagents, live: true))
        let older = PillRow(status: nil, segments: [PillRow.Segment(kind: "subagents", label: "2 subagents", opens: "agents", live: false)])
        #expect(drawn(ThreadFoot(pill: older)).named.transcriptShows(.subagents, live: true))
    }

    private func group(live: Bool?, counted: Bool? = true, machines: [String]) -> BlockRow.Agents {
        BlockRow.Agents(status: "", entries: machines.enumerated().map { index, machine in
            BlockRow.Agents.Entry(id: "a\(index)", agentId: "a\(index)", threadId: "", title: "Child \(index)", state: "working",
                                  label: "Running", token: "working", provider: "codex", model: "", result: "", machine: machine)
        }, live: live, counted: counted)
    }

    @Test func aLiveGroupOnThisMachineIsLeftToThePill() {
        #expect(group(live: true, machines: ["", ""]).leavesToPill)
    }

    @Test func aSettledGroupOrOneFromAnOlderBridgeKeepsItsRow() {
        #expect(!group(live: false, machines: [""]).leavesToPill)
        #expect(!group(live: nil, machines: [""]).leavesToPill)
    }

    @Test func aLiveGroupWithAChildThePillsTreeDoesNotCountKeepsItsRow() {
        // A delegated child the list shows working after the parent's copy went stale: the pill
        // counts only its sibling and its sheet can't open it, so only the row shows it.
        #expect(!group(live: true, counted: false, machines: ["", ""]).leavesToPill)
        #expect(!group(live: true, counted: nil, machines: [""]).leavesToPill)
    }

    @Test func aLiveGroupWithAChildOnAnotherMachineKeepsItsRowWhichOpensItThere() {
        #expect(!group(live: true, machines: ["", "build-box"]).leavesToPill)
    }

    private func line(_ command: String, running: Bool, counted: Bool?) -> BlockRow.Background {
        BlockRow.Background(itemId: command, taskId: command, label: "", command: command, running: running,
                            stoppable: true, startedAt: 0, endedAt: nil, counted: counted)
    }

    @Test func runningCommandsThePillCountsAreLeftToIt() {
        #expect(BlockRow.Background.leaveToPill([line("bun run dev:relay", running: true, counted: true),
                                                 line("bun test", running: false, counted: true)]))
    }

    @Test func aStepWithARunningTaskThePillDoesNotCountKeepsItsRow() {
        // A shell and a monitor: the pill says "1 command" for the shell alone.
        #expect(!BlockRow.Background.leaveToPill([line("bun run dev:relay", running: true, counted: true),
                                                  line("tail -f relay.log", running: true, counted: false)]))
        #expect(!BlockRow.Background.leaveToPill([line("bun run dev:relay", running: true, counted: nil)]))
    }

    @Test func aSettledStepKeepsItsRowAsTheRecord() {
        #expect(!BlockRow.Background.leaveToPill([line("bun test", running: false, counted: true)]))
    }
}
