import Foundation

/// One row of the Threads filter's projects: a logical project across the paired machines
/// (ADR 0189), as the web's project filter groups them. Each machine has its own runtime, so its
/// bridge sends each project's logical ids (`bridge/project-looks.ts`) and checkouts whose ids
/// meet are one row here.
struct ProjectFilterRow: Equatable, Identifiable, Sendable {
    /// What the filter stores: the first checkout's key, `machine/workspace`.
    let id: String
    let name: String
    /// Every checkout it covers, by key.
    let checkouts: Set<String>
    /// The machines it has a checkout on, by host id, in the order they were given.
    let machines: [String]
    /// Threads in it, summed across its checkouts.
    let threads: Int
}

enum ProjectFilterGroups {
    /// One machine's checkout of a project, as the rows name it.
    struct Checkout: Equatable, Sendable {
        let machineId: String
        let workspaceId: String
        let name: String
        /// Its logical ids; empty for a project of its own.
        let logical: [String]
        let threads: Int
        var key: String { ProjectFilterGroups.key(machineId, workspaceId) }
    }

    static func key(_ machineId: String, _ workspaceId: String) -> String { "\(machineId)/\(workspaceId)" }

    /// Checkouts that share a logical id are one row, by name.
    static func rows(_ checkouts: [Checkout]) -> [ProjectFilterRow] {
        var parent = Array(checkouts.indices)
        func root(_ index: Int) -> Int {
            var index = index
            while parent[index] != index { parent[index] = parent[parent[index]]; index = parent[index] }
            return index
        }
        var first: [String: Int] = [:]
        for (index, checkout) in checkouts.enumerated() {
            for id in checkout.logical {
                if let other = first[id] { parent[root(index)] = root(other) } else { first[id] = index }
            }
        }
        var groups: [Int: [Checkout]] = [:]
        var order: [Int] = []
        for index in checkouts.indices {
            let group = root(index)
            if groups[group] == nil { order.append(group) }
            groups[group, default: []].append(checkouts[index])
        }
        return order.compactMap { group -> ProjectFilterRow? in
            guard let members = groups[group], let lead = members.first else { return nil }
            var machines: [String] = []
            for member in members where !machines.contains(member.machineId) { machines.append(member.machineId) }
            return ProjectFilterRow(id: lead.key, name: lead.name, checkouts: Set(members.map(\.key)), machines: machines,
                                    threads: members.reduce(0) { $0 + $1.threads })
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// The group a stored choice names, among every machine's rows, so changing the machine
    /// filter never loses it.
    static func group(for choice: String, in all: [ProjectFilterRow]) -> ProjectFilterRow? { row(for: choice, in: all) }

    /// The row of `shown` (one machine's) that holds the chosen group's checkout there.
    static func shown(for choice: String, in shown: [ProjectFilterRow], across all: [ProjectFilterRow]) -> ProjectFilterRow? {
        guard let group = group(for: choice, in: all) else { return row(for: choice, in: shown) }
        return shown.first { !$0.checkouts.isDisjoint(with: group.checkouts) }
    }

    /// The workspace New thread starts on, on `machine`: that machine's checkout of the chosen
    /// project; none when it has no checkout of it. An id no row knows is passed on as it is.
    static func checkout(of choice: String, on machine: String, in all: [ProjectFilterRow]) -> String? {
        guard !choice.isEmpty else { return nil }
        guard let group = group(for: choice, in: all) else {
            guard let slash = choice.firstIndex(of: "/") else { return choice }
            return choice[..<slash] == machine ? String(choice[choice.index(after: slash)...]) : nil
        }
        let prefix = "\(machine)/"
        return group.checkouts.sorted().first { $0.hasPrefix(prefix) }.map { String($0.dropFirst(prefix.count)) }
    }

    /// The row a stored choice names: a checkout key, or a bare workspace id from an older
    /// choice (Search's project link), matched on any machine.
    static func row(for choice: String, in rows: [ProjectFilterRow]) -> ProjectFilterRow? {
        guard !choice.isEmpty else { return nil }
        if let row = rows.first(where: { $0.checkouts.contains(choice) }) { return row }
        return rows.first { row in row.checkouts.contains { $0.hasSuffix("/\(choice)") } }
    }
}
