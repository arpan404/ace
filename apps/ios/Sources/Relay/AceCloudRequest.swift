import Foundation

/// Builds requests to ace cloud and ace's hosted relay carrying the app's `ace-client` identity
/// (`ios/<version>`, ADR 0189; `@ace/protocol/ace-client`). Debug builds name themselves
/// `ios/development`; release builds use `CFBundleShortVersionString` when it parses as a
/// `ReleaseVersion` (`^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$`, at most 80 ASCII characters), and send
/// no header otherwise rather than a misnamed one.
///
/// The header is added only to ace's own hosts (`*.acehq.dev` over `https`/`wss`): a self-hosted
/// relay (including one on loopback in a Debug build) or any other host never receives it unless
/// a test fixture explicitly opts into loopback via `allowLoopback: true`.
enum AceCloudRequest {
    static let headerName = "ace-client"
    static let appName = "ios"
    static let development = "development"
    static let maxVersionLength = 80
    static let maxValueLength = 96

    #if DEBUG
    static let defaultIsDebug = true
    #else
    static let defaultIsDebug = false
    #endif

    /// This build's `ace-client` value (`ios/development` in Debug, or `ios/<version>` from the
    /// main bundle's `CFBundleShortVersionString` in release builds).
    static var defaultClient: String? { clientValue(bundle: .main) }

    /// The `ace-client` header value for a build: `ios/development` when `isDebug` is true, else
    /// `ios/<CFBundleShortVersionString>` from `bundle` when valid, or nil.
    static func clientValue(bundle: Bundle = .main, isDebug: Bool = defaultIsDebug) -> String? {
        if isDebug { return "\(appName)/\(development)" }
        return clientValue(version: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
    }

    /// `ios/<version>` when `version` is `development` or a valid `ReleaseVersion`, else nil.
    static func clientValue(version: String?) -> String? {
        guard let version, isValidVersion(version) else { return nil }
        let value = "\(appName)/\(version)"
        guard value.utf8.count <= maxValueLength else { return nil }
        return value
    }

    /// Matches `AceClientVersion` (`packages/protocol/src/ace-client.ts`): `development`, or
    /// `ReleaseVersion` (`^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$`, at most 80 ASCII characters).
    static func isValidVersion(_ version: String) -> Bool {
        if version == development { return true }
        let bytes = Array(version.utf8)
        guard !bytes.isEmpty, bytes.count <= maxVersionLength else { return false }
        let dash = UInt8(ascii: "-")
        let dot = UInt8(ascii: ".")
        let split = bytes.firstIndex(of: dash)
        let core = split.map { bytes[..<$0] } ?? bytes[...]
        let segments = core.split(separator: dot, omittingEmptySubsequences: false)
        guard segments.count == 3, segments.allSatisfy({ !$0.isEmpty && $0.allSatisfy(isASCIIDigit) }) else {
            return false
        }
        guard let split else { return true }
        let prerelease = bytes[bytes.index(after: split)...]
        guard !prerelease.isEmpty else { return false }
        return prerelease.allSatisfy { isASCIIDigit($0) || isASCIILower($0) || $0 == dot }
    }

    /// Whether `url` points at one of ace's own cloud or relay hosts (`https`/`wss` on
    /// `*.acehq.dev`). Never true for a relay the person runs themselves (including loopback) or
    /// for plain HTTP/WS to a remote host; loopback is only matched when a test fixture passes
    /// `allowLoopback: true`.
    static func isAceHost(_ url: URL, allowLoopback: Bool = false) -> Bool {
        guard url.user == nil, url.password == nil,
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(),
              !host.isEmpty else { return false }
        if allowLoopback, ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) {
            return ["http", "https", "ws", "wss"].contains(scheme)
        }
        guard scheme == "https" || scheme == "wss" else { return false }
        let suffix = ".acehq.dev"
        return host.hasSuffix(suffix) && host.count > suffix.count && !host.hasPrefix(".") && !host.contains("..")
    }

    /// Whether `value` is a valid `ios/<version>` header value under `@ace/protocol/ace-client`.
    static func isValidClient(_ value: String) -> Bool {
        guard value.utf8.count <= maxValueLength, value.hasPrefix("\(appName)/") else { return false }
        return isValidVersion(String(value.dropFirst(appName.count + 1)))
    }

    /// Builds a `URLRequest` for `url`, setting `ace-client` when `client` is valid and `url` is
    /// one of ace's own hosts.
    static func make(
        url: URL,
        timeoutInterval: TimeInterval = 15,
        cachePolicy: URLRequest.CachePolicy = .useProtocolCachePolicy,
        client: String? = defaultClient,
        allowLoopback: Bool = false
    ) -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: cachePolicy, timeoutInterval: timeoutInterval)
        if let client, isValidClient(client), isAceHost(url, allowLoopback: allowLoopback) {
            request.setValue(client, forHTTPHeaderField: headerName)
        }
        return request
    }

    /// Builds a WebSocket upgrade `URLRequest` carrying both `Sec-WebSocket-Protocol` and (for
    /// ace's own hosts) `ace-client`.
    static func webSocket(
        url: URL,
        protocols: [String],
        client: String? = defaultClient,
        allowLoopback: Bool = false
    ) -> URLRequest {
        var request = make(url: url, client: client, allowLoopback: allowLoopback)
        if !protocols.isEmpty {
            request.setValue(protocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol")
        }
        return request
    }

    private static func isASCIIDigit(_ byte: UInt8) -> Bool { byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9") }
    private static func isASCIILower(_ byte: UInt8) -> Bool { byte >= UInt8(ascii: "a") && byte <= UInt8(ascii: "z") }
}
