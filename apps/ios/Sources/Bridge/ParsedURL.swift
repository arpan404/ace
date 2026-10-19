import Foundation

/// WHATWG-style parts of an absolute URL, for the bridge's minimal `URL` polyfill.
/// Hostnames are lowercased; IPv6 keeps its brackets; default ports are omitted.
struct ParsedURL: Encodable, Equatable {
    let `protocol`: String, username: String, password: String, hostname: String, port: String
    let pathname: String, search: String, hash: String

    static func parse(_ text: String) -> ParsedURL? {
        guard text.utf8.count <= 8192, let parts = URLComponents(string: text), let scheme = parts.scheme,
              let host = parts.host, !host.isEmpty else { return nil }
        return ParsedURL(parts, scheme: scheme.lowercased(), host: host)
    }
    private init(_ parts: URLComponents, scheme: String, host: String) {
        `protocol` = scheme + ":"
        username = parts.percentEncodedUser ?? ""
        password = parts.percentEncodedPassword ?? ""
        let encoded = (parts.percentEncodedHost ?? host).lowercased()
        hostname = encoded.contains(":") && !encoded.hasPrefix("[") ? "[\(encoded)]" : encoded
        let defaults = ["http": 80, "https": 443, "ws": 80, "wss": 443]
        port = parts.port.flatMap { defaults[scheme] == $0 ? nil : String($0) } ?? ""
        pathname = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
        search = parts.percentEncodedQuery.map { $0.isEmpty ? "" : "?" + $0 } ?? ""
        hash = parts.percentEncodedFragment.map { $0.isEmpty ? "" : "#" + $0 } ?? ""
    }
}
