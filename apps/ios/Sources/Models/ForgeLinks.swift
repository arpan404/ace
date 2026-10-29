import Foundation

/// Where taps in GitHub text go, pure. A link opens only as http(s) or mailto (a root path on the
/// forge's host first made absolute); `@user`, `@org/team`, `#123`, `owner/repo#123` and commit
/// references (markit's GitHub flavour) open their pages on the forge; an image loads only from
/// an http(s) address, through the daemon. Anything else stays inert.
struct ForgeLinks: Equatable, Sendable {
    let host: String
    let owner: String
    let name: String

    init(host: String, owner: String, name: String) {
        self.host = host
        self.owner = owner
        self.name = name
    }
    init?(_ repository: ForgeRepository?) {
        guard let repository, !repository.host.isEmpty else { return nil }
        self.init(host: repository.host, owner: repository.owner, name: repository.name)
    }

    private var site: String { "https://\(host)" }
    private var repository: String { "\(site)/\(owner)/\(name)" }

    /// The address a tapped link opens, or nil when it must not open.
    func link(_ url: URL) -> URL? {
        let text = url.absoluteString.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("/"), !text.hasPrefix("//") { return URL(string: site + text) }
        return Self.web(url)
    }

    /// A link that opens without knowing the repository: http(s) and mailto only.
    static func web(_ url: URL) -> URL? {
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return nil }
        return url
    }

    /// The page a GitHub reference opens: a person or team, an issue or pull request, a commit.
    func reference(kind: String, target: String) -> URL? {
        let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_./@#"))
        guard !target.isEmpty, target.unicodeScalars.allSatisfy(safe.contains) else { return nil }
        switch kind {
        case "mention":
            let parts = target.split(separator: "/", omittingEmptySubsequences: false)
            if parts.count == 2 { return URL(string: "\(site)/orgs/\(parts[0])/teams/\(parts[1])") }
            return parts.count == 1 ? URL(string: "\(site)/\(target)") : nil
        case "issue":
            let parts = target.split(separator: "#", omittingEmptySubsequences: false)
            guard parts.count == 2, let number = Int(parts[1]), number > 0 else { return nil }
            if parts[0].isEmpty { return URL(string: "\(repository)/issues/\(number)") }
            guard parts[0].split(separator: "/").count == 2 else { return nil }
            return URL(string: "\(site)/\(parts[0])/issues/\(number)")
        case "commit":
            let parts = target.split(separator: "@", omittingEmptySubsequences: false)
            guard let sha = parts.last, sha.count >= 7, sha.allSatisfy(\.isHexDigit) else { return nil }
            if parts.count == 1 { return URL(string: "\(repository)/commit/\(sha)") }
            guard parts.count == 2, parts[0].split(separator: "/").count == 2 else { return nil }
            return URL(string: "\(site)/\(parts[0])/commit/\(sha)")
        default:
            return nil
        }
    }

    /// The address an image may load from, or nil when it may not.
    func image(_ source: String) -> String? {
        let text = source.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("/"), !text.hasPrefix("//") { return site + text }
        return Self.webImage(text)
    }

    /// An image address that loads without knowing the repository: http(s) only.
    static func webImage(_ source: String) -> String? {
        let text = source.trimmingCharacters(in: .whitespaces)
        guard let scheme = URL(string: text)?.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        return text
    }
}
