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

    @Test func aLiveTreeTheShownPillNamesLeavesTheTranscriptToThePill() {
        let named = ThreadFoot(pill: pill()).named
        #expect(!named.transcriptShows(.subagents, live: true))
        #expect(!named.transcriptShows(.commands, live: true))
    }

    @Test func aSettledRowAlwaysShowsAsTheRecord() {
        let named = ThreadFoot(pill: pill()).named
        #expect(named.transcriptShows(.subagents, live: false))
        #expect(named.transcriptShows(.commands, live: false))
    }

    @Test func aLiveFactThePillDoesNotNameStaysInTheTranscript() {
        let named = ThreadFoot(pill: pill(subagents: true, commands: false)).named
        #expect(!named.transcriptShows(.subagents, live: true))
        #expect(named.transcriptShows(.commands, live: true))
    }

    @Test(arguments: [
        ThreadFoot(requests: true), ThreadFoot(hold: true), ThreadFoot(notSent: true),
        ThreadFoot(leftRunning: true), ThreadFoot(transfer: true), ThreadFoot(work: true),
    ])
    func anyStripTakesThePillsPlaceAndBringsTheLiveRowsBack(_ strip: ThreadFoot) {
        var foot = strip
        foot.pill = pill()
        #expect(foot.shownPill == nil)
        #expect(foot.named.transcriptShows(.subagents, live: true))
        #expect(foot.named.transcriptShows(.commands, live: true))
    }

    @Test func withNoPillOrAnOlderBridgesPillTheTranscriptKeepsEveryLiveRow() {
        #expect(ThreadFoot().named.transcriptShows(.subagents, live: true))
        let older = PillRow(status: nil, segments: [PillRow.Segment(kind: "subagents", label: "2 subagents", opens: "agents", live: false)])
        #expect(ThreadFoot(pill: older).named.transcriptShows(.subagents, live: true))
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
