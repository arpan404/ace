import Foundation

/// Where taps in GitHub text go, pure. A link opens only as http(s) or mailto (a root path on the
/// forge's host first made absolute); `@user`, `@org/team`, `#123`, `owner/repo#123`, commit and
/// pull request references (markit's GitHub flavour) open their pages on the forge, and a file
/// named in code (`src/app.ts:12`) opens in the repository at its default branch; an image loads
/// only from an http(s) address, through the daemon. Anything else stays inert.
struct ForgeLinks: Equatable, Sendable {
    let host: String
    let owner: String
    let name: String
    /// A review on a host ace only reads: its references open by the bridge's templates instead.
    var hosted: ForgeHostedLinks? = nil

    init(host: String, owner: String, name: String, hosted: ForgeHostedLinks? = nil) {
        self.host = host
        self.owner = owner
        self.name = name
        self.hosted = hosted
    }
    init?(_ repository: ForgeRepository?, hosted: ForgeHostedLinks? = nil) {
        guard let repository, !repository.host.isEmpty else { return nil }
        self.init(host: repository.host, owner: repository.owner, name: repository.name, hosted: hosted)
    }

    /// The scheme of an address that opens a review of this repository as ace's own page.
    static let reviewScheme = "ace-review"

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
        if let hosted { return hostedReference(hosted, kind: kind, target: target) }
        switch kind {
        case "pull_request": return URL(string: target).flatMap { link($0) }
        case "file": return file(target)
        default: break
        }
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

    /// A reference in a read-only review's text: `#N` of this repository (an issue on the host,
    /// or the review N in ace), a commit or a person, by the host's templates; else inert.
    private func hostedReference(_ links: ForgeHostedLinks, kind: String, target: String) -> URL? {
        let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_./#"))
        guard !target.isEmpty, target.unicodeScalars.allSatisfy(safe.contains) else { return nil }
        switch kind {
        case "issue":
            let parts = target.split(separator: "#", omittingEmptySubsequences: false)
            guard parts.count == 2, let number = Int(parts[1]), number > 0 else { return nil }
            if !parts[0].isEmpty {
                guard let slash = parts[0].lastIndex(of: "/") else { return nil }
                let named = (owner: parts[0][..<slash], name: parts[0][parts[0].index(after: slash)...])
                guard named.owner.lowercased() == owner.lowercased(), named.name.lowercased() == name.lowercased() else { return nil }
            }
            if links.review { return URL(string: "\(Self.reviewScheme):\(number)") }
            return links.issue.flatMap { URL(string: $0.replacingOccurrences(of: "{number}", with: String(number))) }
        case "commit":
            guard (7...40).contains(target.count), target.allSatisfy(\.isHexDigit) else { return nil }
            return links.commit.flatMap { URL(string: $0.replacingOccurrences(of: "{sha}", with: target)) }
        case "mention":
            guard target != ".", target != "..", !target.contains("/"), !target.contains("#") else { return nil }
            return links.mention.flatMap { URL(string: $0.replacingOccurrences(of: "{login}", with: target)) }
        default:
            return nil
        }
    }

    /// The review number an `ace-review:N` address opens, or nil for any other address.
    static func reviewNumber(_ url: URL) -> Int? {
        guard url.scheme == reviewScheme else { return nil }
        return Int(url.absoluteString.dropFirst(reviewScheme.count + 1)).flatMap { $0 > 0 ? $0 : nil }
    }

    /// A path in the repository, with an optional `:line`, at the default branch on the forge.
    private func file(_ target: String) -> URL? {
        let parts = target.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let path = parts[0].hasPrefix("./") ? parts[0].dropFirst(2) : parts[0]
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_./"))
        guard !path.isEmpty, !path.hasPrefix("/"), path.unicodeScalars.allSatisfy(allowed.contains),
              !path.split(separator: "/").contains("..") else { return nil }
        let line = parts.count == 2 ? Int(parts[1].prefix { $0.isNumber }) : nil
        return URL(string: "\(repository)/blob/HEAD/\(path)" + (line.map { "#L\($0)" } ?? ""))
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
