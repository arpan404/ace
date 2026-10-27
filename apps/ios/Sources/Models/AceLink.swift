import Foundation

/// Links into ace that other apps and Copy link hand around: `ace://thread/<id>?machine=<host>`,
/// the same scheme the desktop app opens. Reading one is the shared runtime's (`deep-link.ts`).
enum AceLink {
    static let scheme = "ace"

    static func thread(_ id: String, machine: String?) -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "thread"
        components.path = "/" + id
        if let machine, !machine.isEmpty { components.queryItems = [URLQueryItem(name: "machine", value: machine)] }
        return components.url ?? URL(string: "ace://thread")!
    }
}
