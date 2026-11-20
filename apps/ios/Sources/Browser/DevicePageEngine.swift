import CryptoKit
import Foundation
import WebKit

/// The phone's own web view for a device tab (ADR 0194): each machine keeps its own cookies and
/// storage, and a public page can't reach the machine's localhost through the phone's listeners.
enum DevicePageEngine {
    /// The data store's identifier for a machine: the same machine always gets the same one, so
    /// its sign-ins last across launches, and two machines never share one. Pure.
    static func storeIdentifier(hostId: String) -> UUID {
        var bytes = Array(SHA256.hash(data: Data("ace.device-tab.\(hostId)".utf8)).prefix(16))
        // An RFC 4122 name-based UUID's version and variant bits.
        bytes[6] = (bytes[6] & 0x0F) | 0x50
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    /// The loopback hosts, one pattern each: WebKit's rule lists have no alternation.
    static let loopbackPatterns = [
        "^[a-z]+://localhost[:/]",
        "^[a-z]+://[^/:?#]+\\.localhost[:/]",
        "^[a-z]+://127\\.[0-9]+\\.[0-9]+\\.[0-9]+[:/]",
        "^[a-z]+://\\[::1\\][:/]",
    ]

    /// Blocks every loopback request (pages, fetches, websockets, frames) unless the top-level page
    /// is itself on a loopback host. A top-level navigation to loopback is that page, so an OAuth
    /// flow that leaves for a provider and redirects back to `localhost` still loads.
    static func ruleList() -> String {
        let rules: [[String: Any]] = loopbackPatterns.map { pattern in
            ["trigger": ["url-filter": pattern, "unless-top-url": loopbackPatterns], "action": ["type": "block"]]
        }
        let data = (try? JSONSerialization.data(withJSONObject: rules, options: [.sortedKeys])) ?? Data("[]".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// Whether `host` is the machine's loopback: `localhost`, a name under it, `127.0.0.0/8` or
    /// `::1` (bracketed or not). Pure.
    static func isLoopbackHost(_ host: String?) -> Bool {
        guard var host = host?.lowercased(), !host.isEmpty else { return false }
        if host.hasSuffix(".") { host.removeLast() }
        if host == "localhost" || host.hasSuffix(".localhost") { return true }
        if host == "::1" || host == "[::1]" { return true }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts[0] == "127" && parts.allSatisfy { part in
            !part.isEmpty && part.count <= 3 && part.allSatisfy(\.isNumber) && (Int(part) ?? 256) <= 255
        }
    }

    /// `@ace/ui-core`'s `loopbackNavigationAllowed` (ADR 0194), kept here because WebKit's policy
    /// can't wait on the script: a top-level navigation to loopback goes ahead when a loopback
    /// document or the person started it, or when it is a GET (links, `location`, a 302 or 303
    /// back to localhost); any other non-GET is refused. WebKit reports a redirect's request with
    /// the method it is sent with, so no redirect status is needed here. Tested against the same
    /// table (`loopback-navigation-cases.json`). Pure.
    static func loopbackNavigationAllowed(method: String, initiatorIsLoopback: Bool, byPerson: Bool, redirectStatus: Int? = nil) -> Bool {
        if initiatorIsLoopback || byPerson { return true }
        var effective = method.uppercased()
        if redirectStatus == 303, effective != "HEAD" { effective = "GET" }
        if redirectStatus == 301 || redirectStatus == 302, effective == "POST" { effective = "GET" }
        return effective == "GET"
    }

    /// Whether a main-frame navigation may go ahead: anything not to loopback does; one to
    /// loopback follows `loopbackNavigationAllowed`. Pure.
    static func allowsMainFrame(to url: URL?, method: String?, sourceHost: String?, byPerson: Bool) -> Bool {
        guard isLoopbackHost(url?.host(percentEncoded: false)) else { return true }
        return loopbackNavigationAllowed(method: method ?? "GET", initiatorIsLoopback: isLoopbackHost(sourceHost), byPerson: byPerson)
    }

    static let ruleListIdentifier = "ace.device-tab.loopback.v1"

    /// The compiled rule list, made once for the app.
    @MainActor private static var compiled: WKContentRuleList?
    @MainActor private static var waiting: [(WKContentRuleList?) -> Void] = []

    @MainActor static func loopbackRules(_ done: @escaping (WKContentRuleList?) -> Void) {
        if let compiled { done(compiled); return }
        waiting.append(done)
        guard waiting.count == 1 else { return }
        // Sendable and hopping to the main queue itself: WebKit may answer on any thread, and a
        // closure inferred to be on the main actor would trap there.
        let finish: @Sendable (WKContentRuleList?, (any Error)?) -> Void = { list, _ in
            nonisolated(unsafe) let list = list
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    compiled = list
                    let callbacks = waiting
                    waiting.removeAll()
                    for callback in callbacks { callback(list) }
                }
            }
        }
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: ruleListIdentifier, encodedContentRuleList: ruleList(),
                                                                completionHandler: finish)
    }

    /// A web view for one of `hostId`'s device tabs. No proxy is set: iOS sends loopback to the
    /// phone itself, where the listeners take it, and every other host goes direct.
    @MainActor static func webView(hostId: String) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: storeIdentifier(hostId: hostId))
        configuration.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.allowsBackForwardNavigationGestures = true
        // A blank or loading page shows the app's own background, dark or light, not white.
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.isInspectable = true
        return view
    }
}
