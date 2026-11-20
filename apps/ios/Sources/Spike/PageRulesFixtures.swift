#if ACE_FIXTURE
import Darwin
import Foundation
import Network
import UIKit
import WebKit

/// Fixtures for the device page rules (ADR 0194), in fixture builds only: the tests and the
/// device check (`--loopback-rules`) run the same pages against them. Two small HTTP servers: the
/// machine's localhost, behind the phone's real loopback listeners, and a public site on the
/// phone's own network address (not loopback, so the rules treat it as any other host).

/// One HTTP request a fixture server saw.
struct SeenRequest: Equatable, Sendable {
    let method: String
    let path: String
}

/// An answer: status, extra headers and body.
struct FixtureResponse: Sendable {
    var status = 200
    var headers: [String: String] = [:]
    var body = "ok"
    static func html(_ body: String) -> FixtureResponse { FixtureResponse(headers: ["Content-Type": "text/html"], body: body) }
    static func redirect(_ status: Int, to location: String) -> FixtureResponse {
        FixtureResponse(status: status, headers: ["Location": location], body: "")
    }
}

/// Reads one request from bytes as they come; answers once it is whole. Pure.
struct RequestReader {
    private var buffer = Data()
    mutating func push(_ bytes: Data) -> SeenRequest? {
        buffer.append(bytes)
        guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
        let lines = head.components(separatedBy: "\r\n")
        let first = lines.first?.split(separator: " ") ?? []
        guard first.count >= 2 else { return nil }
        let length = lines.dropFirst().compactMap { line -> Int? in
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2, parts[0].lowercased() == "content-length" else { return nil }
            return Int(parts[1].trimmingCharacters(in: .whitespaces))
        }.first ?? 0
        guard buffer.count - end.upperBound >= length else { return nil }
        return SeenRequest(method: String(first[0]), path: String(first[1]))
    }

    static func encode(_ response: FixtureResponse) -> Data {
        let body = Data(response.body.utf8)
        var head = "HTTP/1.1 \(response.status) Fixture\r\nContent-Length: \(body.count)\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n"
        for (name, value) in response.headers { head += "\(name): \(value)\r\n" }
        return Data((head + "\r\n").utf8) + body
    }
}

/// What a fixture server saw, in order; read from any thread.
final class SeenRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [SeenRequest] = []
    func add(_ request: SeenRequest) { lock.withLock { seen.append(request) } }
    var all: [SeenRequest] { lock.withLock { seen } }
    func first(path prefix: String) -> SeenRequest? { all.first { $0.path.hasPrefix(prefix) } }
}

/// The machine's localhost for a page: the phone's real listeners (`LoopbackHub`) hand each
/// connection here, as they would to the tunnel, and this answers it as HTTP.
final class LoopbackHTTPMachine: LoopbackClient, @unchecked Sendable {
    let seen = SeenRequests()
    private let hub: LoopbackHub
    private let route: @Sendable (SeenRequest) -> FixtureResponse
    private let lock = NSLock()
    private var readers: [String: RequestReader] = [:]

    init(hub: LoopbackHub, route: @escaping @Sendable (SeenRequest) -> FixtureResponse) {
        self.hub = hub; self.route = route
    }

    func loopback(_ event: LoopbackEvent) {
        switch event {
        case .accept(let id, _):
            lock.withLock { readers[id] = RequestReader() }
            hub.act(id, action: "read", bytes: nil)
        case .data(let id, let bytes):
            let request = lock.withLock { () -> SeenRequest? in
                guard var reader = readers[id] else { return nil }
                let request = reader.push(bytes)
                readers[id] = request == nil ? reader : nil
                return request
            }
            guard let request else { hub.act(id, action: "read", bytes: nil); return }
            seen.add(request)
            hub.act(id, action: "write", bytes: RequestReader.encode(route(request)))
            hub.act(id, action: "end", bytes: nil)
            hub.act(id, action: "close", bytes: nil)
        case .written, .end, .reset, .released: break
        }
    }
}

/// A public site on the phone's own network address: an ordinary listener on every interface.
final class PublicHTTPServer: @unchecked Sendable {
    let seen = SeenRequests()
    private let listener: NWListener
    private let queue = DispatchQueue(label: "ace.fixture.public")

    /// Up and listening, or nil.
    static func start(route: @escaping @Sendable (SeenRequest) -> FixtureResponse) async -> PublicHTTPServer? {
        guard let listener = try? NWListener(using: .tcp, on: .any) else { return nil }
        let server = PublicHTTPServer(listener: listener, route: route)
        let up: Bool = await withCheckedContinuation { continuation in
            let once = OnceFlag()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: if once.take() { continuation.resume(returning: true) }
                case .failed, .cancelled: if once.take() { continuation.resume(returning: false) }
                default: break
                }
            }
            listener.start(queue: server.queue)
        }
        return up ? server : nil
    }

    private init(listener: NWListener, route: @escaping @Sendable (SeenRequest) -> FixtureResponse) {
        self.listener = listener
        let seen = seen, queue = queue
        listener.newConnectionHandler = { connection in
            connection.start(queue: queue)
            Self.serve(connection, reader: RequestReader(), seen: seen, route: route)
        }
    }

    var port: Int { Int(listener.port?.rawValue ?? 0) }

    private static func serve(_ connection: NWConnection, reader: RequestReader, seen: SeenRequests,
                              route: @escaping @Sendable (SeenRequest) -> FixtureResponse) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, complete, error in
            var reader = reader
            if let data, let request = reader.push(data) {
                seen.add(request)
                connection.send(content: RequestReader.encode(route(request)), contentContext: .finalMessage, isComplete: true,
                                completion: .contentProcessed { _ in connection.cancel() })
                return
            }
            if complete || error != nil { connection.cancel(); return }
            serve(connection, reader: reader, seen: seen, route: route)
        }
    }

    func stop() { listener.cancel() }

    /// The phone's own IPv4 address on its network (Wi-Fi first), which isn't loopback.
    static func networkAddress() -> String? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }
        var found: [(String, String)] = []
        for entry in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(entry.pointee.ifa_flags)
            guard let address = entry.pointee.ifa_addr, address.pointee.sa_family == sa_family_t(AF_INET),
                  flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let text = String(cString: host)
            // Link-local addresses are not routable as a page's host.
            if text.hasPrefix("169.254.") { continue }
            found.append((String(cString: entry.pointee.ifa_name), text))
        }
        return found.first { $0.0 == "en0" }?.1 ?? found.first?.1
    }
}

/// True the first time only; for continuations a state handler may resume more than once.
private final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var taken = false
    func take() -> Bool { lock.withLock { defer { taken = true }; return !taken } }
}

/// One page and what it should manage: whether its request reaches the machine's localhost.
struct PageRulesScenario: Sendable {
    enum Origin: Sendable { case publicSite, loopback }
    let name: String
    let origin: Origin
    /// The page, given the machine's base (`http://localhost:P`), the public base and this
    /// scenario's hit path on the machine.
    let html: @Sendable (_ machine: String, _ publicBase: String, _ hit: String) -> String
    /// Whether the hit reaches the machine, and with which method.
    let reaches: String?
    /// Where the person's own load starts, given the same bases and the page's path; the page
    /// itself unless given (a public URL that redirects, say).
    var start: (@Sendable (_ machine: String, _ publicBase: String, _ hit: String) -> String)?
    /// The name as a path segment: letters, digits and dashes only, so it sits in any quoted HTML.
    var id: String {
        String(name.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" })
    }
}

extension PageRulesScenario {
    /// Each refused request beside the same request from a loopback page, which must arrive: a
    /// refusal that WebKit or a broken listener caused instead would fail its control.
    static let all: [PageRulesScenario] = [
        fetch(.publicSite, reaches: nil), fetch(.loopback, reaches: "GET"),
        frame(.publicSite, reaches: nil), frame(.loopback, reaches: "GET"),
        socket(.publicSite, reaches: nil), socket(.loopback, reaches: "GET"),
        form(.publicSite, reaches: nil), form(.loopback, reaches: "POST"),
        PageRulesScenario(name: "a public page's link to localhost loads", origin: .publicSite, html: { machine, _, hit in
            "<a href='\(machine)\(hit)'>go</a><script>document.links[0].click()</script>"
        }, reaches: "GET"),
        PageRulesScenario(name: "a public page's script sending the page to localhost loads", origin: .publicSite, html: { machine, _, hit in
            "<script>location.href = '\(machine)\(hit)?code=1'</script>"
        }, reaches: "GET"),
        redirect(302, post: false, reaches: "GET"),
        redirect(303, post: true, reaches: "GET"),
        redirect(307, post: true, reaches: nil),
        redirect(307, post: false, reaches: "GET"),
        // The other spellings of the machine's loopback a page can name, as subresources.
        image(.publicSite, host: "localhost.", reaches: nil), image(.loopback, host: "localhost.", reaches: "GET"),
        image(.publicSite, host: "user@localhost", reaches: nil), image(.loopback, host: "user@localhost", reaches: "GET"),
        image(.publicSite, host: "127.0.0.1.", reaches: nil), image(.loopback, host: "127.0.0.1.", reaches: "GET"),
        image(.publicSite, host: "LOCALHOST", reaches: nil),
        image(.publicSite, host: "app.localhost.", reaches: nil),
        image(.publicSite, host: "[::1]", reaches: nil),
        // The person's own load is the person's through each redirect, whatever its status.
        personRedirect(302), personRedirect(303), personRedirect(307), personRedirect(308),
    ]

    /// The person opens a public address that redirects to localhost with `status`.
    private static func personRedirect(_ status: Int) -> PageRulesScenario {
        PageRulesScenario(name: "the person's own load redirected to localhost with \(status)", origin: .publicSite,
                          html: { _, _, _ in "" }, reaches: "GET",
                          start: { machine, publicBase, hit in "\(publicBase)/redirect/\(status)?to=\(machine)\(hit)" })
    }

    /// An image from the machine named by `host` instead of `localhost`.
    private static func image(_ origin: Origin, host: String, reaches: String?) -> PageRulesScenario {
        PageRulesScenario(name: "\(label(origin)) loading an image from \(host)", origin: origin, html: { machine, _, hit in
            "<img src='\(machine.replacingOccurrences(of: "://localhost", with: "://\(host)"))\(hit)'>"
        }, reaches: reaches)
    }

    private static func label(_ origin: Origin) -> String { origin == .publicSite ? "a public page" : "a localhost page" }
    private static func fetch(_ origin: Origin, reaches: String?) -> PageRulesScenario {
        PageRulesScenario(name: "\(label(origin)) fetching localhost", origin: origin, html: { machine, _, hit in
            "<script>fetch('\(machine)\(hit)').catch(() => {})</script>"
        }, reaches: reaches)
    }
    private static func frame(_ origin: Origin, reaches: String?) -> PageRulesScenario {
        PageRulesScenario(name: "\(label(origin)) framing localhost", origin: origin, html: { machine, _, hit in
            "<iframe src='\(machine)\(hit)'></iframe>"
        }, reaches: reaches)
    }
    private static func socket(_ origin: Origin, reaches: String?) -> PageRulesScenario {
        PageRulesScenario(name: "\(label(origin)) opening a websocket to localhost", origin: origin, html: { machine, _, hit in
            "<script>new WebSocket('\(machine.replacingOccurrences(of: "http:", with: "ws:"))\(hit)')</script>"
        }, reaches: reaches)
    }
    private static func form(_ origin: Origin, reaches: String?) -> PageRulesScenario {
        PageRulesScenario(name: "\(label(origin)) posting a form to localhost", origin: origin, html: { machine, _, hit in
            "<form method='post' action='\(machine)\(hit)'><input name='a' value='1'></form><script>document.forms[0].submit()</script>"
        }, reaches: reaches)
    }
    /// A public page's request to the public site, which redirects to localhost with `status`.
    private static func redirect(_ status: Int, post: Bool, reaches: String?) -> PageRulesScenario {
        PageRulesScenario(name: "a public \(post ? "form post" : "link") redirected to localhost with \(status)", origin: .publicSite, html: { machine, publicBase, hit in
            let target = "\(publicBase)/redirect/\(status)?to=\(machine)\(hit)"
            return post ? "<form method='post' action='\(target)'><input name='a' value='1'></form><script>document.forms[0].submit()</script>"
                : "<a href='\(target)'>go</a><script>document.links[0].click()</script>"
        }, reaches: reaches)
    }

}

/// Pages by path, read by a server's queue and written by the run.
final class PageBook: @unchecked Sendable {
    private let lock = NSLock()
    private var pages: [String: String] = [:]
    func put(_ path: String, _ html: String) { lock.withLock { pages[path] = html } }
    /// A page, a redirect to where `/redirect/<status>?to=` says, or a hit's plain answer.
    func answer(_ request: SeenRequest) -> FixtureResponse {
        let parts = request.path.split(separator: "?", maxSplits: 1)
        let path = String(parts.first ?? "")
        if path.hasPrefix("/redirect/"), let status = Int(path.dropFirst("/redirect/".count)),
           let query = parts.dropFirst().first, query.hasPrefix("to=") {
            return .redirect(status, to: String(query.dropFirst(3)))
        }
        if let html = lock.withLock({ pages[path] }) { return .html(html) }
        return path.hasPrefix("/hit/") ? FixtureResponse(body: "<p>reached</p>") : FixtureResponse(status: 404, body: "")
    }
}

/// Runs scenarios on real device-tab web views: the rule list, the main-frame policy and the
/// phone's real listeners, with the machine's localhost and a public site as fixtures.
@MainActor final class PageRulesRun {
    let machine: LoopbackHTTPMachine
    let publicSite: PublicHTTPServer
    let machinePort: Int
    /// What the machine's port answered when it was asked for: it must be listening.
    let listening: LoopbackListening
    private let hub: LoopbackHub
    private let book: PageBook
    private let publicBase: String
    private let window: UIView?

    /// Nil when the phone has no network address to stand for a public site.
    static func start(in window: UIView?) async -> PageRulesRun? {
        guard let address = PublicHTTPServer.networkAddress() else { return nil }
        let book = PageBook()
        guard let site = await PublicHTTPServer.start(route: { book.answer($0) }) else { return nil }
        let hub = LoopbackHub(queue: DispatchQueue(label: "ace.fixture.rules"))
        let machine = LoopbackHTTPMachine(hub: hub) { book.answer($0) }
        let port = freeLoopbackPort()
        let listening = await withCheckedContinuation { continuation in hub.listen([port], for: machine) { continuation.resume(returning: $0) } }
        return PageRulesRun(hub: hub, machine: machine, site: site, port: port, listening: listening, book: book,
                            publicBase: "http://\(address):\(site.port)", window: window)
    }

    private init(hub: LoopbackHub, machine: LoopbackHTTPMachine, site: PublicHTTPServer, port: Int, listening: LoopbackListening,
                 book: PageBook, publicBase: String, window: UIView?) {
        self.hub = hub; self.machine = machine; self.publicSite = site; self.machinePort = port; self.listening = listening
        self.book = book; self.publicBase = publicBase; self.window = window
    }

    /// The method the scenario's hit reached the machine with, or nil if it never did.
    func run(_ scenario: PageRulesScenario) async -> String? {
        let rules: WKContentRuleList? = await withCheckedContinuation { continuation in
            DevicePageEngine.loopbackRules { continuation.resume(returning: $0) }
        }
        guard let rules else { return "no rule list" }
        let view = DevicePageEngine.webView(hostId: "page-rules-check")
        view.configuration.userContentController.add(rules)
        view.frame = CGRect(x: 0, y: 0, width: 320, height: 480)
        window?.addSubview(view)
        let coordinator = DevicePageCoordinator()
        coordinator.follow(view, tab: scenario.id, status: DevicePageStatus(), report: { _, _, _ in }, failed: { _, _ in })
        defer { view.stopLoading(); view.removeFromSuperview(); _ = coordinator }
        let machineBase = "http://localhost:\(machinePort)"
        let hit = "/hit/\(scenario.id)"
        let page = "/page/\(scenario.id)"
        book.put(page, scenario.html(machineBase, publicBase, hit))
        let base = scenario.origin == .publicSite ? publicBase : machineBase
        let start = URL(string: scenario.start?(machineBase, publicBase, hit) ?? base + page)!
        coordinator.personLoads(start)
        view.load(URLRequest(url: start))
        // One that should arrive gets four seconds; one that shouldn't is given two to try.
        let deadline = Date().addingTimeInterval(scenario.reaches == nil ? 2 : 4)
        while Date() < deadline {
            if let seen = machine.seen.first(path: hit) { return seen.method }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return machine.seen.first(path: hit)?.method
    }

    func stop() {
        hub.listen([], for: machine) { _ in }
        publicSite.stop()
    }
}

/// A loopback port nothing listens on now: bound on port 0 and let go.
func freeLoopbackPort() -> Int {
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
#endif
