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

/// An answer: status, extra headers and body, sent after `delay` seconds.
struct FixtureResponse: Sendable {
    var status = 200
    var headers: [String: String] = [:]
    var body = "ok"
    var delay: Double = 0
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
                let response = route(request)
                DispatchQueue.global().asyncAfter(deadline: .now() + response.delay) {
                    connection.send(content: RequestReader.encode(response), contentContext: .finalMessage, isComplete: true,
                                    completion: .contentProcessed { _ in connection.cancel() })
                }
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
    /// A page the scenario frames, at `/inner/<id>` on both servers, given the same bases.
    var inner: (@Sendable (_ machine: String, _ publicBase: String, _ hit: String) -> String)?
    /// More pages and scripts, by path, on both servers, given the same bases.
    var pages: (@Sendable (_ machine: String, _ publicBase: String, _ hit: String) -> [String: String])?
    /// What the page must report it tried (`ping`, at `/ran/<id>/<attempt>` on the public site)
    /// before a refusal counts: a request that never reached the machine because the page never
    /// ran, or never made it, proves nothing.
    var attempts: [String] = []
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
        // The person's own load goes through each redirect to localhost, whatever its status: it
        // is a GET, and so is every redirect of it.
        personRedirect(302), personRedirect(303), personRedirect(307), personRedirect(308),
    ] + framedRequests + [
        // The frame rule's known cost (ADR 0194): a frame with no URL of its own is matched as
        // `about:srcdoc`, so even a localhost page's own is refused. Letting `about:` frames
        // through would let a public frame reach the machine from a blank frame it makes.
        PageRulesScenario(name: "a localhost page's srcdoc frame is refused localhost too", origin: .loopback, html: { machine, _, hit in
            "<iframe srcdoc=\"<img src='\(machine)\(hit)'>\"></iframe>"
        }, reaches: nil),
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
    private var posts: [String: Int] = [:]
    func put(_ path: String, _ html: String) { lock.withLock { pages[path] = html } }
    /// A page; a redirect to where `/redirect/<status>?to=` says; `/resubmit/<id>?to=`, whose first
    /// POST shows a page and whose later ones (a form sent again) go on with a 307, POST kept;
    /// `/slow?to=`, a redirect that takes a second; or a hit's plain answer.
    func answer(_ request: SeenRequest) -> FixtureResponse {
        let parts = request.path.split(separator: "?", maxSplits: 1)
        let path = String(parts.first ?? "")
        let to = parts.dropFirst().first.flatMap { $0.hasPrefix("to=") ? String($0.dropFirst(3)) : nil }
        if path.hasPrefix("/redirect/"), let status = Int(path.dropFirst("/redirect/".count)), let to {
            return .redirect(status, to: to)
        }
        if path.hasPrefix("/resubmit/"), request.method == "POST", let to {
            let count = lock.withLock { () -> Int in posts[path, default: 0] += 1; return posts[path] ?? 0 }
            return count == 1 ? .html("<p>posted</p>") : .redirect(307, to: to)
        }
        if path == "/slow", let to {
            var response = FixtureResponse.redirect(302, to: to)
            response.delay = 1
            return response
        }
        if let body = lock.withLock({ pages[path] }) {
            return path.hasSuffix(".js") ? FixtureResponse(headers: ["Content-Type": "text/javascript"], body: body) : .html(body)
        }
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
    let book: PageBook
    let publicBase: String
    let window: UIView?

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

    /// The attempts the scenario's page should have reported and didn't.
    func missingAttempts(_ scenario: PageRulesScenario) -> [String] {
        scenario.attempts.filter { publicSite.seen.first(path: "/ran/\(scenario.id)/\($0)") == nil }
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
        let coordinator = DevicePageCoordinator(tab: scenario.id, status: DevicePageStatus())
        coordinator.attach(view)
        defer { view.stopLoading(); view.removeFromSuperview(); _ = coordinator }
        let machineBase = "http://localhost:\(machinePort)"
        let hit = "/hit/\(scenario.id)"
        let page = "/page/\(scenario.id)"
        book.put(page, scenario.html(machineBase, publicBase, hit))
        if let inner = scenario.inner { book.put("/inner/\(scenario.id)", inner(machineBase, publicBase, hit)) }
        for (path, body) in scenario.pages?(machineBase, publicBase, hit) ?? [:] { book.put(path, body) }
        let base = scenario.origin == .publicSite ? publicBase : machineBase
        let start = URL(string: scenario.start?(machineBase, publicBase, hit) ?? base + page)!
        view.load(URLRequest(url: start))
        // One that should arrive gets four seconds; one that shouldn't is given two to try, from
        // when it reported its attempts if it reports them.
        let started = Date()
        while !scenario.attempts.isEmpty, !missingAttempts(scenario).isEmpty, Date() < started.addingTimeInterval(4) {
            try? await Task.sleep(for: .milliseconds(50))
        }
        let deadline = Date().addingTimeInterval(scenario.reaches == nil ? 2 : 4)
        while Date() < deadline {
            if let seen = machine.seen.first(path: hit) { return seen.method }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return machine.seen.first(path: hit)?.method
    }

    /// Every method the journey's hit reached the machine with, in order, once its steps ran, and
    /// the requests the public site saw meanwhile.
    func run(_ journey: PageJourney) async -> (machine: [String], publicSite: [SeenRequest]) {
        let rules: WKContentRuleList? = await withCheckedContinuation { continuation in
            DevicePageEngine.loopbackRules { continuation.resume(returning: $0) }
        }
        guard let rules else { return (["no rule list"], []) }
        let view = DevicePageEngine.webView(hostId: "page-rules-check")
        view.configuration.userContentController.add(rules)
        view.frame = CGRect(x: 0, y: 0, width: 320, height: 480)
        window?.addSubview(view)
        let coordinator = DevicePageCoordinator(tab: journey.id, status: DevicePageStatus())
        coordinator.attach(view)
        defer { view.stopLoading(); view.removeFromSuperview(); _ = coordinator }
        let bases = PageJourney.Bases(machine: "http://localhost:\(machinePort)", publicSite: publicBase, id: journey.id)
        for (path, html) in journey.pages(bases) { book.put(path, html) }
        for step in journey.steps {
            switch step {
            case .load(let url): view.load(URLRequest(url: URL(string: url(bases))!))
            case .reload: view.reload()
            case .script(let script): view.evaluateJavaScript(script(bases), completionHandler: nil)
            }
            try? await Task.sleep(for: .milliseconds(journey.settleMs))
        }
        let hits = machine.seen.all.filter { $0.path.hasPrefix(bases.hit) && (journey.counted ?? $0.method) == $0.method }
            .map(\.method)
        return (hits, publicSite.seen.all)
    }

    func stop() {
        hub.listen([], for: machine) { _ in }
        publicSite.stop()
    }
}

/// Several navigations in one tab, each as the person makes it in ace (the app's own load,
/// reload, or a script the page runs), and every method its hit reaches the machine with.
struct PageJourney: Sendable {
    struct Bases: Sendable {
        let machine: String
        let publicSite: String
        let id: String
        /// The path whose requests the journey counts on the machine.
        var hit: String { "/hit/\(id)" }
    }
    enum Step: Sendable {
        /// The app loads this address for the person.
        case load(@Sendable (Bases) -> String)
        /// The person taps Reload.
        case reload
        /// The page on screen runs this.
        case script(@Sendable (Bases) -> String)
    }
    let name: String
    /// Pages by path, served by both the machine and the public site.
    let pages: @Sendable (Bases) -> [String: String]
    let steps: [Step]
    let reaches: [String]
    var settleMs = 1200
    /// Only hits with this method are counted, when given.
    var counted: String?
    /// When given, the public site must have seen these requests (path prefix and method), in
    /// order: the journey's refusal means nothing unless the request it refuses was made.
    var publicSees: (@Sendable (Bases) -> (path: String, methods: [String]))?
    var id: String { String(name.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }) }
}

extension PageJourney {
    private static func form(_ action: String) -> String {
        "<form method='post' action='\(action)'><input name='a' value='1'></form><script>document.forms[0].submit()</script>"
    }

    static let all: [PageJourney] = [
        // A localhost app's form, resubmitted by the person's reload: the page on screen is on
        // localhost, so it goes again.
        PageJourney(name: "a localhost form resubmitted by the person's reload reaches again", pages: { b in
            ["/page/\(b.id)": form("\(b.machine)\(b.hit)")]
        }, steps: [.load { b in "\(b.machine)/page/\(b.id)" }, .reload], reaches: ["POST", "POST"]),
        // A public page's form, which its server sends on to localhost only when it is sent
        // again: the person's reload resends a page's POST, which is never the person's own.
        PageJourney(name: "a public form the person's reload resubmits through a 307 to localhost is refused", pages: { b in
            ["/page/\(b.id)": form("\(b.publicSite)/resubmit/\(b.id)?to=\(b.machine)\(b.hit)")]
        }, steps: [.load { b in "\(b.publicSite)/page/\(b.id)" }, .reload], reaches: [], publicSees: { b in
            // The form's POST and the reload's replay of it, which the server sends on with a 307.
            ("/resubmit/\(b.id)", ["POST", "POST"])
        }),
        // The person's load is still under way (its answer takes a second) when the page on
        // screen posts a form that a 307 sends on to localhost: the post stays the page's.
        PageJourney(name: "a public form posted while the person's own load is under way is refused", pages: { b in
            ["/page/\(b.id)": "<form method='post' action='\(b.publicSite)/redirect/307?to=\(b.machine)\(b.hit)'><input name='a' value='1'></form>"]
        }, steps: [
            .load { b in "\(b.publicSite)/page/\(b.id)" },
            .load { b in "\(b.publicSite)/slow?to=\(b.publicSite)/page/\(b.id)" },
            .script { _ in "document.forms[0].submit()" },
        ], reaches: [], settleMs: 700),
        // A script moving through history and then posting: the post is the page's.
        PageJourney(name: "a public page that pushes history state and then posts to localhost is refused", pages: { b in
            ["/page/\(b.id)": "<form method='post' action='\(b.machine)\(b.hit)'><input name='a' value='1'></form>"]
        }, steps: [
            .load { b in "\(b.publicSite)/page/\(b.id)" },
            .script { _ in "history.pushState({}, '', '/page/pushed'); document.forms[0].submit()" },
        ], reaches: []),
        // A localhost form's result, then a public page whose script goes back to it: whatever
        // WebKit does to show it again (on iOS 26.1 it fetches it with a GET), it never sends the
        // POST again for the public page.
        PageJourney(name: "a public page's history.back to a localhost form's result sends no POST again", pages: { b in
            ["/page/\(b.id)": form("\(b.machine)\(b.hit)"), "/public/\(b.id)": "<p>public</p>"]
        }, steps: [
            .load { b in "\(b.machine)/page/\(b.id)" },
            .load { b in "\(b.publicSite)/public/\(b.id)" },
            .script { _ in "history.back()" },
        ], reaches: ["POST"], counted: "POST"),
        // A public page opening localhost in a window of its own: the device tab opens none.
        PageJourney(name: "a public page's window.open and form to a new window reach nothing", pages: { b in
            ["/page/\(b.id)": "<form method='post' target='_blank' action='\(b.machine)\(b.hit)'><input name='a' value='1'></form>"]
        }, steps: [
            .load { b in "\(b.publicSite)/page/\(b.id)" },
            .script { b in "window.open('\(b.machine)\(b.hit)?open'); document.forms[0].submit()" },
        ], reaches: []),
    ]
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
