import Foundation

/// A bot that New group and a group's profile offer as a member: one bot of one machine.
struct SpadeMemberChoice: Equatable, Hashable, Sendable, Identifiable {
    /// The inbox key of its machine: where a request about it goes.
    let machine: String
    /// That machine's ace host id, which a group names its members' machines by.
    let host: String
    let machineName: String
    let agent: String
    let name: String
    let face: SpadeModel.Face
    /// Spade itself, which leads when the person picks no other.
    let main: Bool
    /// Its machine doesn't answer now, or the bot is off.
    let away: Bool
    var id: String { "\(host)/\(agent)" }
}

/// A member as Spade takes it: `machine` is its bot's host id, nil for the group's own machine.
struct SpadeMemberRef: Equatable, Sendable {
    let agent: String
    let machine: String?
    var json: [String: Any] { machine.map { ["agent": agent, "machine": $0] } ?? ["agent": agent] }
}

/// A group's rules for the New group draft and the profile's edits (ADR 0132,
/// spade/docs/teams.md), as web's `group-draft.ts` has them: which bots are offered, which may
/// lead, why a draft can't be made yet, and what Spade is sent. Swift repeats them because the
/// draft spans machines, each with its own JavaScript runtime. Pure.
enum SpadeGroupDraft {
    /// Fewest and most members a group holds, the lead counted, and the longest name
    /// (`spadeGroupMembersMin`, `spadeGroupMembersMax`, `spadeGroupNameMax`).
    static let membersMin = 2
    static let membersMax = 32
    static let nameMax = 60

    /// Every bot of the machines that show Spade, never a group, in the list's order.
    static func choices(_ machines: [SpadeRoster.Machine]) -> [SpadeMemberChoice] {
        machines.flatMap { machine in
            machine.bots.filter { $0.group == nil }.map { bot in
                SpadeMemberChoice(machine: machine.key, host: machine.host ?? machine.key, machineName: machine.name,
                                  agent: bot.id, name: bot.name,
                                  face: bot.faces.first ?? SpadeModel.Face(main: bot.main, initial: bot.initial, away: false),
                                  main: bot.main, away: !machine.answering || bot.state == "off")
            }
        }
    }

    // MARK: New group

    /// What the draft starts with picked: Spade on the machine it shows from, when it runs there.
    static func start(_ choices: [SpadeMemberChoice], spadeOn machine: String?) -> [String] {
        choices.first { $0.main && $0.machine == machine }.map { [$0.id] } ?? []
    }

    /// The picked choices, in the order they were picked.
    static func picked(_ choices: [SpadeMemberChoice], _ ids: [String]) -> [SpadeMemberChoice] {
        ids.compactMap { id in choices.first { $0.id == id } }
    }

    /// Past this many bots the member list searches.
    static let searchFrom = 9

    /// The members to list for `query`: all of them while the query is empty; else those whose
    /// name or machine holds it, a picked bot always listed.
    static func shown(_ choices: [SpadeMemberChoice], query: String, picked ids: Set<String>) -> [SpadeMemberChoice] {
        let words = query.trimmingCharacters(in: .whitespaces)
        guard !words.isEmpty else { return choices }
        return choices.filter {
            ids.contains($0.id) || $0.name.localizedStandardContains(words) || $0.machineName.localizedStandardContains(words)
        }
    }

    /// The draft's lead, who answers what has no @: the one asked for while it is picked, else
    /// Spade while it is picked, else the first picked. The group lives on its lead's machine.
    static func lead(_ picked: [SpadeMemberChoice], asked: String?) -> SpadeMemberChoice? {
        picked.first { $0.id == asked } ?? picked.first(where: \.main) ?? picked.first
    }

    /// Why the draft can't be made yet, in words; nil when it can. It is made on its lead's
    /// machine, so that machine must answer.
    static func problem(name: String, picked: [SpadeMemberChoice], lead: SpadeMemberChoice?) -> String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Name the club." }
        if picked.count < membersMin { return "Pick at least one more bot." }
        if picked.count > membersMax { return "A club holds up to \(membersMax) bots." }
        if let lead, lead.away { return "\(lead.name)'s machine isn't answering." }
        return nil
    }

    /// The members as the lead's machine takes them: its own bots unnamed, the rest by host id.
    static func refs(_ picked: [SpadeMemberChoice], on host: String) -> [SpadeMemberRef] {
        picked.map { SpadeMemberRef(agent: $0.agent, machine: $0.host == host ? nil : $0.host) }
    }

    // MARK: A group's profile

    /// A member as the group's profile has it.
    struct Member: Decodable, Equatable, Sendable, Identifiable {
        let agent: String
        /// Its bot's host id; nil for the group's own machine.
        let machine: String?
        let name: String
        let face: SpadeModel.Face
        let away: Bool
        var id: String { "\(machine ?? "")/\(agent)" }
        var ref: SpadeMemberRef { SpadeMemberRef(agent: agent, machine: machine) }
    }

    /// Whether `member` is the group's lead.
    static func isLead(_ member: Member, lead: SpadeMemberRef) -> Bool {
        member.agent == lead.agent && member.machine == lead.machine
    }

    /// Who may lead: the members on the group's own machine, in the group's order.
    static func leads(_ members: [Member]) -> [Member] { members.filter { $0.machine == nil } }

    /// Whether a member can be removed: never the lead, and never below the fewest a group holds.
    static func removable(_ member: Member, from members: [Member], lead: SpadeMemberRef) -> Bool {
        !isLead(member, lead: lead) && members.count > membersMin
    }

    /// The bots to offer under Add a member: those not in it yet, the group's machine's first,
    /// none once it is full.
    static func others(_ choices: [SpadeMemberChoice], members: [Member], groupHost: String) -> [SpadeMemberChoice] {
        guard members.count < membersMax else { return [] }
        let taken = Set(members.map { "\($0.machine ?? groupHost)/\($0.agent)" })
        let left = choices.filter { !taken.contains($0.id) }
        return left.filter { $0.host == groupHost } + left.filter { $0.host != groupHost }
    }

    /// The member to add, named against the group's machine.
    static func joining(_ choice: SpadeMemberChoice, groupHost: String) -> SpadeMemberRef {
        SpadeMemberRef(agent: choice.agent, machine: choice.host == groupHost ? nil : choice.host)
    }

    /// A rename as Spade takes it: one line, trimmed, at most `nameMax`; nil when nothing changes.
    static func rename(_ draft: String, from name: String) -> String? {
        let line = draft.components(separatedBy: .newlines).filter { !$0.isEmpty }.joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        let cut = String(line.prefix(nameMax))
        return cut.isEmpty || cut == name ? nil : cut
    }
}
