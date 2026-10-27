import Foundation

/// One machine's answer for a fleet rule: its value, or that it couldn't be read.
enum FleetRuleAnswer: Equatable, Sendable {
    case value(ServiceValue)
    case failed
}

/// Where a fleet rule stands across the connected machines. Agreement is claimed only when
/// every machine answered with the same value; a machine that failed or hasn't answered makes
/// the rule incomplete, never quietly left out.
enum FleetRuleState: Equatable, Sendable {
    case agreed(ServiceValue)
    case differs
    /// These machines (host ids) failed or haven't answered; the ones that did agree.
    case incomplete([String])

    static func of(key: String, hosts: [String], answers: [String: FleetRuleAnswer]) -> FleetRuleState {
        var values: [ServiceValue] = []
        var unread: [String] = []
        for host in hosts {
            switch answers[host] {
            case .value(let value)?: values.append(normalized(key, value))
            case .failed?, nil: unread.append(host)
            }
        }
        if let first = values.first, values.contains(where: { $0 != first }) { return .differs }
        if !unread.isEmpty { return .incomplete(unread) }
        guard let first = values.first else { return .incomplete(hosts) }
        return .agreed(first)
    }

    /// "local" is remote access off; the transport shows the network it would open on.
    private static func normalized(_ key: String, _ value: ServiceValue) -> ServiceValue {
        if key == "remote.transport", case .string("local") = value { return .string("lan") }
        return value
    }

    var value: ServiceValue? { if case .agreed(let value) = self { value } else { nil } }
}
