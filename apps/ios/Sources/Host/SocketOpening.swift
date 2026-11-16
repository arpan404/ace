import Foundation

/// What the script asks `aceHost.socket(id, "open", value)` to open (`packages/native-host`).
/// The empty value is the runtime's own daemon socket. A media connection (ADR 0147 §4) names
/// ace-media's listener as `{"media":{"url":"wss://…/media"}}`, or `{"media":{}}` when only the
/// relay reaches the machine. A runtime that reaches its machine through the relay opens a relay
/// stream with the `media` purpose either way. Swift only
/// carries it: the ticket, the hello, acks and reconnecting are the shared script's. Pure.
enum SocketOpening: Equatable, Sendable {
    case daemon
    case media(URL?)
    case invalid

    private struct Media: Decodable { let url: String? }
    private struct Body: Decodable { let media: Media }

    static func parse(_ value: String) -> SocketOpening {
        if value.isEmpty { return .daemon }
        guard value.utf8.count <= 4096, let body = try? JSONDecoder().decode(Body.self, from: Data(value.utf8)) else { return .invalid }
        guard let text = body.media.url else { return .media(nil) }
        guard let url = URL(string: text) else { return .invalid }
        return .media(url)
    }
}
