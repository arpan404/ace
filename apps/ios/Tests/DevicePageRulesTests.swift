import Darwin
import Foundation
import Testing
import WebKit
@testable import Ace

/// What reached the phone's listener from a device tab's web view.
private final class Accepts: LoopbackClient, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func loopback(_ event: LoopbackEvent) { if case .accept = event { lock.withLock { count += 1 } } }
    var accepted: Int { lock.withLock { count } }
}

private func freePort() -> Int {
    let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    defer { close(socket) }
    var address = sockaddr_in(sin_len: UInt8(MemoryLayout<sockaddr_in>.size), sin_family: sa_family_t(AF_INET),
                              sin_port: 0, sin_addr: in_addr(s_addr: inet_addr("127.0.0.1")), sin_zero: (0, 0, 0, 0, 0, 0, 0, 0))
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    withUnsafeMutablePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { _ = bind(socket, $0, length); _ = getsockname(socket, $0, &length) }
    }
    return Int(UInt16(bigEndian: address.sin_port))
}

/// The rule list on a real web view: a public page can't reach loopback, but going to a
/// loopback page from it (an OAuth redirect back to localhost) does.
@Suite(.serialized) @MainActor struct DevicePageRulesTests {
    private func page() async throws -> WKWebView {
        let rules: WKContentRuleList? = await withCheckedContinuation { continuation in
            DevicePageEngine.loopbackRules { continuation.resume(returning: $0) }
        }
        let view = DevicePageEngine.webView(hostId: "rules-test")
        view.configuration.userContentController.add(try #require(rules))
        view.frame = CGRect(x: 0, y: 0, width: 320, height: 480)
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.windows.first }.first?.addSubview(view)
        return view
    }
    private func listening() async -> (LoopbackHub, Accepts, Int) {
        let hub = LoopbackHub(queue: DispatchQueue(label: "test.rules"))
        let accepts = Accepts(), port = freePort()
        _ = await withCheckedContinuation { continuation in hub.listen([port], for: accepts) { continuation.resume(returning: $0) } }
        return (hub, accepts, port)
    }

    @Test func aPublicPageCantFetchTheMachinesLocalhost() async throws {
        let (hub, accepts, port) = await listening()
        let view = try await page()
        defer { view.removeFromSuperview(); hub.listen([], for: accepts) { _ in } }
        view.loadHTMLString("<script>fetch('http://127.0.0.1:\(port)/x').catch(() => {}); new Image().src = 'http://localhost:\(port)/i.png'</script>",
                            baseURL: URL(string: "https://example.com/")!)
        try await Task.sleep(for: .seconds(2))
        #expect(accepts.accepted == 0)
    }

    @Test func aLoopbackPageFetchesItsOwnPorts() async throws {
        let (hub, accepts, port) = await listening()
        let view = try await page()
        defer { view.removeFromSuperview(); hub.listen([], for: accepts) { _ in } }
        view.loadHTMLString("<script>fetch('http://127.0.0.1:\(port)/x').catch(() => {})</script>",
                            baseURL: URL(string: "http://localhost:\(port + 1)/")!)
        for _ in 0..<40 where accepts.accepted == 0 { try await Task.sleep(for: .milliseconds(50)) }
        #expect(accepts.accepted > 0)
    }

    @Test func goingFromAPublicPageToLocalhostLoads() async throws {
        let (hub, accepts, port) = await listening()
        let view = try await page()
        defer { view.removeFromSuperview(); hub.listen([], for: accepts) { _ in } }
        view.loadHTMLString("<p>signed in</p>", baseURL: URL(string: "https://example.com/")!)
        try await Task.sleep(for: .milliseconds(500))
        view.load(URLRequest(url: URL(string: "http://localhost:\(port)/callback")!))
        for _ in 0..<40 where accepts.accepted == 0 { try await Task.sleep(for: .milliseconds(50)) }
        #expect(accepts.accepted > 0)
    }

    @Test func aPublicPageRedirectingToLocalhostLoads() async throws {
        let (hub, accepts, port) = await listening()
        let view = try await page()
        defer { view.removeFromSuperview(); hub.listen([], for: accepts) { _ in } }
        view.loadHTMLString("<script>location.href = 'http://localhost:\(port)/callback?code=1'</script>",
                            baseURL: URL(string: "https://example.com/")!)
        for _ in 0..<40 where accepts.accepted == 0 { try await Task.sleep(for: .milliseconds(50)) }
        #expect(accepts.accepted > 0)
    }
}
