import Testing
@testable import Ace

/// The Spade tab's one list across machines: Spade once, from the machine the fleet chose, then
/// every other bot by state and latest activity, each from its own machine.
@Suite struct SpadeRosterTests {
    @Test func twoMachinesListEveryBotOnceWithSpadeFirstFromTheChosenHost() {
        let entries = SpadeRoster.merge([
            machine("laptop", record: record("laptop-host", 1, at: 9), bots: [main("laptop", created: 1), bot("notes", at: 5)]),
            machine("studio", record: record("studio-host", 2, at: 1), bots: [main("studio", created: 9), bot("plan", at: 7)]),
        ])
        #expect(entries.map(\.id) == ["studio/main-studio", "studio/plan", "laptop/notes"])
        #expect(entries.map(\.machine) == ["studio", "studio", "laptop"])
    }

    @Test func spadeShowsFromTheChosenHostWhileThatHostIsAway() {
        let entries = SpadeRoster.merge([
            machine("laptop", record: record("studio-host", 3), bots: [main("laptop", created: 1)]),
            machine("studio", answering: false, record: record("studio-host", 3),
                    bots: [main("studio", created: 9, state: "off")]),
        ])
        #expect(entries.map(\.id) == ["studio/main-studio"])
        #expect(entries.first?.bot.state == "off")
    }

    @Test func aChoiceNamingAMachineThatListedNoSpadeShowsNoneRatherThanAnother() {
        let entries = SpadeRoster.merge([
            machine("laptop", record: record("server-host", 1), bots: [main("laptop", created: 1), bot("notes", at: 2)]),
        ])
        #expect(entries.map(\.id) == ["laptop/notes"])
    }

    @Test func beforeAnyChoiceSpadeIsTheOldestMainOfTheMachinesAnswering() {
        let cases: [(machines: [SpadeRoster.Machine], shown: String?)] = [
            ([machine("laptop", bots: [main("laptop", created: 9)]),
              machine("studio", bots: [main("studio", created: 5)])], "studio/main-studio"),
            // An older main on a machine that doesn't answer now isn't chosen.
            ([machine("laptop", bots: [main("laptop", created: 9)]),
              machine("server", answering: false, bots: [main("server", created: 1, state: "off")])], "laptop/main-laptop"),
            // As old as each other: the host id decides, as on the web.
            ([machine("b", bots: [main("b", created: 5)]), machine("a", bots: [main("a", created: 5)])], "a/main-a"),
            ([machine("server", answering: false, bots: [main("server", created: 1, state: "off")])], nil),
        ]
        for (machines, shown) in cases {
            #expect(SpadeRoster.merge(machines).first { $0.bot.main }?.id == shown)
        }
    }

    @Test func twoMainsAsOldAsEachOtherBreakTheTieByHostIdNotByTheInboxKey() {
        // The inbox keys sort one way and the host ids the other: the host id decides.
        let first = SpadeRoster.Machine(key: "a-inbox", name: "A", host: "zeta", answering: true, record: nil,
                                        bots: [main("a", created: 5)])
        let second = SpadeRoster.Machine(key: "b-inbox", name: "B", host: "alpha", answering: true, record: nil,
                                         bots: [main("b", created: 5)])
        #expect(SpadeRoster.merge([first, second]).first?.id == "b-inbox/main-b")
        #expect(SpadeRoster.merge([second, first]).first?.id == "b-inbox/main-b")
    }

    @Test func theNewestChoiceWinsByVersionThenTimeThenHost() {
        #expect(SpadeRoster.newest([record("a", 1, at: 9), record("b", 2, at: 1)])?.host == "b")
        #expect(SpadeRoster.newest([record("a", 2, at: 9), record("b", 2, at: 1)])?.host == "a")
        #expect(SpadeRoster.newest([record("a", 2, at: 1), record("b", 2, at: 1)])?.host == "b")
        #expect(SpadeRoster.newest([]) == nil)
    }

    @Test func theRestSortByStateThenLatestActivityAcrossMachines() {
        let entries = SpadeRoster.merge([
            machine("laptop", bots: [bot("quiet", at: 50), bot("asker", at: 1, rank: 0)]),
            machine("studio", bots: [bot("busy", at: 10, rank: 1), bot("old", at: 2)]),
        ])
        #expect(entries.map(\.bot.id) == ["asker", "busy", "quiet", "old"])
    }

    @Test func awayAndUnavailableMachinesKeepTheirBotsListedAsTheBridgePutThem() {
        let entries = SpadeRoster.merge([
            machine("laptop", answering: false, bots: [bot("notes", at: 5, rank: 4, state: "off")]),
            machine("studio", bots: [bot("plan", at: 1)]),
        ])
        #expect(entries.map(\.id) == ["laptop/notes", "studio/plan"])
        #expect(!entries.contains { $0.bot.state == "working" })
    }

    @Test func theSameBotIdOnTwoMachinesListsTwice() {
        let entries = SpadeRoster.merge([
            machine("laptop", bots: [bot("notes", at: 5)]),
            machine("studio", bots: [bot("notes", at: 4)]),
        ])
        #expect(entries.map(\.id) == ["laptop/notes", "studio/notes"])
    }

    private func machine(_ key: String, answering: Bool = true, record: SpadeModel.HostRecord? = nil,
                         bots: [SpadeModel.Bot]) -> SpadeRoster.Machine {
        SpadeRoster.Machine(key: key, name: key.capitalized, host: "\(key)-host", answering: answering, record: record, bots: bots)
    }

    private func record(_ host: String, _ version: Int, at: Double = 1) -> SpadeModel.HostRecord {
        SpadeModel.HostRecord(host: host, version: version, at: at, by: "person")
    }

    private func main(_ machine: String, created: Double, state: String = "rest") -> SpadeModel.Bot {
        row("main-\(machine)", main: true, at: 0, created: created, rank: 4, state: state)
    }

    private func bot(_ id: String, at: Double, rank: Int = 4, state: String = "rest") -> SpadeModel.Bot {
        row(id, main: false, at: at, created: 0, rank: rank, state: state)
    }

    private func row(_ id: String, main: Bool, at: Double, created: Double, rank: Int, state: String) -> SpadeModel.Bot {
        SpadeModel.Bot(id: id, conversation: "c-\(id)", name: id, main: main, initial: "N", group: nil, faces: [],
                       state: state, line: "", pinned: false, at: at, createdAt: created, rank: rank)
    }
}
