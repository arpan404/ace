import Foundation

enum PairingLinkError: Error, Equatable {
    case notALink, insecure, wrongPath, credentialsInURL, missingCode, invalidPin

    var message: String {
        switch self {
        case .notALink: "That isn't an ace pairing link. Run `ace pair` or open Remote devices on your computer."
        case .insecure: "Pairing links must use HTTPS from your own computer."
        case .wrongPath, .credentialsInURL: "Use the complete pairing link from your computer, unchanged."
        case .missingCode: "This link has no pairing code. Create a new link on your computer."
        case .invalidPin: "This link has no valid computer fingerprint, so it can't be verified."
        }
    }
}

/// A link from `ace pair` or Remote devices: `https://host:port/pair#fingerprint=…&code=…&scopes=…`.
/// The fragment carries the code and pin; only scheme, host and port are ever used for networking.
struct PairingLink: Sendable, Equatable {
    let socketURL: URL
    let displayHost: String
    let code: String
    let fingerprint: String
    let scopes: [String]

    static func parse(_ text: String) throws(PairingLinkError) -> PairingLink {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf8.count <= 4096, let components = URLComponents(string: trimmed), let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty else { throw .notALink }
        guard scheme == "https" else { throw .insecure }
        guard components.user == nil, components.password == nil, components.query == nil else { throw .credentialsInURL }
        guard components.path == "/pair" else { throw .wrongPath }
        var fragment = URLComponents()
        fragment.percentEncodedQuery = components.percentEncodedFragment
        let values = fragment.queryItems ?? []
        func value(_ name: String) -> String? { values.first { $0.name == name }?.value }
        guard let code = value("code"), !code.isEmpty, code.utf8.count <= 256 else { throw .missingCode }
        guard let pin = value("fingerprint")?.lowercased(), PinnedTrust.isPin(pin) else { throw .invalidPin }
        var socket = URLComponents()
        socket.scheme = "wss"
        socket.percentEncodedHost = components.percentEncodedHost
        socket.port = components.port
        socket.path = "/"
        guard let url = socket.url else { throw .notALink }
        let scopes = (value("scopes") ?? "").split(separator: ",").map(String.init).filter { !$0.isEmpty }
        let shown = components.port.map { "\(host):\($0)" } ?? host
        return PairingLink(socketURL: url, displayHost: shown, code: code, fingerprint: pin, scopes: scopes)
    }

    /// Groups of four for comparing against the computer's screen.
    var fingerprintGroups: String {
        stride(from: 0, to: fingerprint.count, by: 4).map { offset in
            let start = fingerprint.index(fingerprint.startIndex, offsetBy: offset)
            return String(fingerprint[start..<fingerprint.index(start, offsetBy: 4)])
        }.joined(separator: " ")
    }
    var accessSummary: String { Grants(scopes: scopes).summary }
}

/// Scopes the host chose; redemption cannot add any.
struct Grants: Sendable, Equatable {
    let scopes: [String]
    var canOperate: Bool { scopes.contains("operate") || scopes.contains("admin") }
    var summary: String {
        if scopes.isEmpty { return "Chosen by your computer" }
        if scopes.contains("admin") { return "Administrator" }
        return canOperate ? "View and act" : "View only"
    }
}
