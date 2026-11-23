import Testing
@testable import Ace

/// New group's draft and a group's profile edits: Spade starts picked, a group needs two bots and
/// a name, the lead's machine is where it lives, and members of other machines are named by host.
@Suite struct SpadeGroupDraftTests {
    private let machines = [
        Self.machine("laptop", host: "laptop-host", bots: [Self.bot("spade", main: true), Self.bot("notes"), Self.group("launch")]),
        Self.machine("studio", host: "studio-host", answering: false, bots: [Self.bot("render")]),
    ]

    @Test func everyBotOfEveryMachineIsOfferedButNoGroup() {
        let choices = SpadeGroupDraft.choices(machines)
        #expect(choices.map(\.id) == ["laptop-host/spade", "laptop-host/notes", "studio-host/render"])
        #expect(choices.map(\.away) == [false, false, true])
    }

    @Test func theDraftStartsWithSpadeOfTheMachineItShowsFromPicked() {
        let choices = SpadeGroupDraft.choices(machines)
        #expect(SpadeGroupDraft.start(choices, spadeOn: "laptop") == ["laptop-host/spade"])
        #expect(SpadeGroupDraft.start(choices, spadeOn: "studio").isEmpty)
        #expect(SpadeGroupDraft.start(choices, spadeOn: nil).isEmpty)
    }

    @Test func aGroupCantBeMadeWithoutANameOrWithFewerThanTwoBots() {
        let choices = SpadeGroupDraft.choices(machines)
        let spade = SpadeGroupDraft.picked(choices, ["laptop-host/spade"])
        let two = SpadeGroupDraft.picked(choices, ["laptop-host/spade", "laptop-host/notes"])
        #expect(SpadeGroupDraft.problem(name: "  ", picked: two, lead: SpadeGroupDraft.lead(two, asked: nil)) == "Name the club.")
        #expect(SpadeGroupDraft.problem(name: "Launch", picked: [], lead: SpadeGroupDraft.lead([], asked: nil)) == "Pick at least one more bot.")
        #expect(SpadeGroupDraft.problem(name: "Launch", picked: spade, lead: SpadeGroupDraft.lead(spade, asked: nil)) == "Pick at least one more bot.")
        #expect(SpadeGroupDraft.problem(name: "Launch", picked: two, lead: SpadeGroupDraft.lead(two, asked: nil)) == nil)
    }

    @Test func aGroupHoldsAtMostThirtyTwoBots() {
        let many = (0..<33).map { Self.bot("b\($0)") }
        let choices = SpadeGroupDraft.choices([Self.machine("laptop", host: "h", bots: many)])
        let all = SpadeGroupDraft.picked(choices, Set(choices.map(\.id)))
        #expect(SpadeGroupDraft.problem(name: "Crowd", picked: all, lead: SpadeGroupDraft.lead(all, asked: nil)) == "A club holds up to 32 bots.")
        #expect(SpadeGroupDraft.problem(name: "Crowd", picked: Array(all.prefix(32)), lead: SpadeGroupDraft.lead(Array(all.prefix(32)), asked: nil)) == nil)
    }

    @Test func searchingTheMembersKeepsEveryPickedBotListed() {
        let choices = SpadeGroupDraft.choices(machines)
        let shown = SpadeGroupDraft.shown(choices, query: "REN", picked: ["laptop-host/spade"])
        #expect(shown.map(\.agent) == ["spade", "render"])
        #expect(SpadeGroupDraft.shown(choices, query: "studio", picked: []).map(\.agent) == ["render"])
        #expect(SpadeGroupDraft.shown(choices, query: " ", picked: []).count == 3)
    }

    @Test func spadeLeadsWhilePickedUnlessAnotherIsAskedFor() {
        let choices = SpadeGroupDraft.choices(machines)
        let picked = SpadeGroupDraft.picked(choices, ["laptop-host/notes", "laptop-host/spade"])
        #expect(SpadeGroupDraft.lead(picked, asked: nil)?.agent == "spade")
        #expect(SpadeGroupDraft.lead(picked, asked: "laptop-host/notes")?.agent == "notes")
        // Asked for one no longer picked: the rule picks again.
        #expect(SpadeGroupDraft.lead(picked, asked: "studio-host/render")?.agent == "spade")
        let noSpade = SpadeGroupDraft.picked(choices, ["laptop-host/notes", "studio-host/render"])
        #expect(SpadeGroupDraft.lead(noSpade, asked: nil)?.agent == "notes")
    }

    @Test func aLeadWhoseMachineDoesntAnswerCantMakeTheGroup() {
        let choices = SpadeGroupDraft.choices(machines)
        let picked = SpadeGroupDraft.picked(choices, ["studio-host/render", "laptop-host/notes"])
        let notes = SpadeGroupDraft.lead(picked, asked: nil)
        let render = SpadeGroupDraft.lead(picked, asked: "studio-host/render")
        #expect(SpadeGroupDraft.problem(name: "Launch", picked: picked, lead: notes) == nil)
        #expect(SpadeGroupDraft.problem(name: "Launch", picked: picked, lead: render) == "render's machine isn't answering.")
    }

    @Test func membersOfTheLeadsMachineGoUnnamedAndOthersByHost() {
        let choices = SpadeGroupDraft.choices(machines)
        let picked = SpadeGroupDraft.picked(choices, ["laptop-host/notes", "studio-host/render"])
        #expect(SpadeGroupDraft.refs(picked, on: "laptop-host")
            == [SpadeMemberRef(agent: "notes", machine: nil), SpadeMemberRef(agent: "render", machine: "studio-host")])
    }

    @Test func theLeadIsNeverRemovableNorIsAnyoneFromAGroupOfTwo() {
        let lead = SpadeMemberRef(agent: "spade", machine: nil)
        let three = [member("spade"), member("notes"), member("render", on: "studio-host")]
        #expect(!SpadeGroupDraft.removable(three[0], from: three, lead: lead))
        #expect(SpadeGroupDraft.removable(three[1], from: three, lead: lead))
        #expect(!SpadeGroupDraft.removable(three[1], from: Array(three.prefix(2)), lead: lead))
        #expect(SpadeGroupDraft.removing(three[1], from: three).map(\.agent) == ["spade", "render"])
    }

    @Test func onlyMembersOfTheGroupsOwnMachineMayLead() {
        let members = [member("spade"), member("render", on: "studio-host"), member("notes")]
        #expect(SpadeGroupDraft.leads(members).map(\.agent) == ["spade", "notes"])
    }

    @Test func addOffersBotsNotInTheGroupItsOwnMachinesFirst() {
        let choices = SpadeGroupDraft.choices([
            Self.machine("studio", host: "studio-host", bots: [Self.bot("render"), Self.bot("paint")]),
            Self.machine("laptop", host: "laptop-host", bots: [Self.bot("spade", main: true), Self.bot("notes")]),
        ])
        let members = [member("spade"), member("render", on: "studio-host")]
        let others = SpadeGroupDraft.others(choices, members: members, groupHost: "laptop-host")
        #expect(others.map(\.id) == ["laptop-host/notes", "studio-host/paint"])
        let added = SpadeGroupDraft.adding(others[1], to: members, groupHost: "laptop-host")
        #expect(added == [SpadeMemberRef(agent: "spade", machine: nil), SpadeMemberRef(agent: "render", machine: "studio-host"),
                          SpadeMemberRef(agent: "paint", machine: "studio-host")])
        let full = (0..<32).map { member("b\($0)") }
        #expect(SpadeGroupDraft.others(choices, members: full, groupHost: "laptop-host").isEmpty)
    }

    @Test func aRenameIsOneTrimmedLineAndNothingWhenUnchanged() {
        #expect(SpadeGroupDraft.rename("  Ship\nit  ", from: "Launch") == "Ship it")
        #expect(SpadeGroupDraft.rename(" Launch ", from: "Launch") == nil)
        #expect(SpadeGroupDraft.rename("   ", from: "Launch") == nil)
        #expect(SpadeGroupDraft.rename(String(repeating: "a", count: 80), from: "Launch")?.count == 60)
    }

    private static func machine(_ key: String, host: String, answering: Bool = true, bots: [SpadeModel.Bot]) -> SpadeRoster.Machine {
        SpadeRoster.Machine(key: key, name: key.capitalized, host: host, answering: answering, record: nil, bots: bots)
    }
    private static func bot(_ id: String, main: Bool = false) -> SpadeModel.Bot {
        SpadeModel.Bot(id: id, conversation: "c-\(id)", name: id, main: main, initial: "X", group: nil,
                       faces: [SpadeModel.Face(main: main, initial: "X", away: false)], state: "rest", line: "", pinned: false)
    }
    private static func group(_ id: String) -> SpadeModel.Bot {
        SpadeModel.Bot(id: "group:\(id)", conversation: "c-\(id)", name: id, main: false, initial: "X", group: id,
                       faces: [], state: "rest", line: "", pinned: false)
    }
    private func member(_ agent: String, on machine: String? = nil) -> SpadeGroupDraft.Member {
        SpadeGroupDraft.Member(agent: agent, machine: machine, name: agent,
                               face: SpadeModel.Face(main: false, initial: "X", away: false), away: false)
    }
}
