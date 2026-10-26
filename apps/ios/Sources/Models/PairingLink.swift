import Foundation

enum PairingLinkError: Error, Equatable {
    case notALink, insecure, wrongPath, credentialsInURL, missingCode, invalidPin

    var message: String {
        switch self {
        case .notALink: "That isn't an ace pairing link. Run `ace pair` or open Settings › Machines and devices on your computer."
        case .insecure: "Pairing links must use HTTPS from your own computer."
        case .wrongPath, .credentialsInURL: "Use the complete pairing link from your computer, unchanged."
        case .missingCode: "This link has no pairing code. Create a new link on your computer."
        case .invalidPin: "This link has no valid computer fingerprint, so it can't be verified."
        }
    }
}

/// A link from `ace pair` or Machines and devices: `https://host:port/pair#fingerprint=…&code=…&scopes=…`.
/// A link that opens the hosted web app names the computer in its fragment instead:
/// `https://app.acehq.dev/pair#host=https%3A%2F%2Fhost%3Aport&fingerprint=…`.
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
        var computer = components
        if let named = value("host") {
            guard let address = URLComponents(string: named), let namedHost = address.host, !namedHost.isEmpty,
                  address.path.isEmpty || address.path == "/", address.query == nil, address.fragment == nil else { throw .notALink }
            guard address.scheme?.lowercased() == "https" else { throw .insecure }
            guard address.user == nil, address.password == nil else { throw .credentialsInURL }
            computer = address
        }
        guard let computerHost = computer.host else { throw .notALink }
        var socket = URLComponents()
        socket.scheme = "wss"
        socket.percentEncodedHost = computer.percentEncodedHost
        socket.port = computer.port
        socket.path = "/"
        guard let url = socket.url else { throw .notALink }
        let scopes = (value("scopes") ?? "").split(separator: ",").map(String.init).filter { !$0.isEmpty }
        let shown = computer.port.map { "\(computerHost):\($0)" } ?? computerHost
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
        let access = scopes.contains("admin") ? "Administrator" : canOperate ? "View and act" : "View only"
        return ([access] + (scopes.contains("projects") ? ["Projects"] : []) + (scopes.contains("accounts") ? ["Accounts"] : [])).joined(separator: " · ")
    }
}
