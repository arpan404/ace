#if ACE_FIXTURE
import Foundation

/// Frames inside a localhost page reaching for the machine's localhost (ADR 0194), in fixture
/// builds only. Each request is made once from a public frame, which must reach nothing, and once
/// from a localhost frame, which must arrive: a refusal that WebKit or a broken listener caused
/// instead would fail its control. The public frame reports each attempt (`ping`) first, so a
/// frame that never loaded or never ran can't pass for a refusal.
struct FramedRequest: Sendable {
    /// What a frame and its page see: the machine's base, the public site's, the frame's own
    /// origin, the hit's path and the scenario's id.
    struct Bases: Sendable {
        let machine: String
        let publicBase: String
        let own: String
        let hit: String
        let id: String
        var socket: String { machine.replacingOccurrences(of: "http:", with: "ws:") }
        /// Reports `what` was tried, to the public site; it outlives a navigation.
        var ping: String {
            "<script>function ping(what) { fetch('\(publicBase)/ran/\(id)/' + what, { mode: 'no-cors', keepalive: true }).catch(() => {}) }</script>"
        }
    }

    let request: String
    /// The method a localhost frame's request reaches the machine with.
    let reaches: String
    /// What the frame's pages report, in `ping` calls, once they ran and tried.
    let attempts: [String]
    /// The framed page's body, after `ping` is defined.
    let html: @Sendable (Bases) -> String
    /// More pages and scripts by path, on both servers.
    var pages: (@Sendable (Bases) -> [String: String])?

    /// The scenario: a localhost page framing `origin`'s `/inner/<id>`, which makes this request.
    func scenario(_ origin: PageRulesScenario.Origin) -> PageRulesScenario {
        let frame = origin == .publicSite ? "a public frame" : "a localhost frame"
        let bases: @Sendable (String, String, String) -> Bases = { machine, publicBase, hit in
            Bases(machine: machine, publicBase: publicBase, own: origin == .publicSite ? publicBase : machine, hit: hit,
                  id: String(hit.dropFirst("/hit/".count)))
        }
        let html = html, pages = pages
        typealias Page = @Sendable (String, String, String) -> String
        let outer: Page = { machine, publicBase, hit in
            // The framed page is `/inner/<id>`, beside the hit `/hit/<id>`.
            let inner = bases(machine, publicBase, hit).own + hit.replacingOccurrences(of: "/hit/", with: "/inner/")
            return "<iframe src='\(inner)'></iframe>"
        }
        let inner: Page = { machine, publicBase, hit in
            let b = bases(machine, publicBase, hit)
            return b.ping + html(b)
        }
        var scenario = PageRulesScenario(name: "\(frame) in a localhost page \(request)", origin: .loopback, html: outer,
                                         reaches: origin == .publicSite ? nil : reaches)
        scenario.inner = inner
        if let pages {
            scenario.pages = { machine, publicBase, hit in pages(bases(machine, publicBase, hit)) }
        }
        if origin == .publicSite { scenario.attempts = attempts }
        return scenario
    }

    static let all: [FramedRequest] = [
        FramedRequest(request: "fetching localhost", reaches: "GET", attempts: ["fetch"]) { b in
            "<script>fetch('\(b.machine)\(b.hit)').catch(() => {}); ping('fetch')</script>"
        },
        FramedRequest(request: "loading an image from localhost", reaches: "GET", attempts: ["image"]) { b in
            "<img src='\(b.machine)\(b.hit)'><script>ping('image')</script>"
        },
        FramedRequest(request: "posting a form to localhost", reaches: "POST", attempts: ["form"]) { b in
            "<form method='post' action='\(b.machine)\(b.hit)'><input name='a' value='1'></form><script>ping('form'); document.forms[0].submit()</script>"
        },
        FramedRequest(request: "navigating itself to localhost", reaches: "GET", attempts: ["navigate"]) { b in
            "<script>ping('navigate'); location.href = '\(b.machine)\(b.hit)'</script>"
        },
        FramedRequest(request: "framing localhost", reaches: "GET", attempts: ["frame"]) { b in
            "<script>ping('frame')</script><iframe src='\(b.machine)\(b.hit)'></iframe>"
        },
        // A document load two frames down: the nested frame is the public frame's own page.
        FramedRequest(request: "framing its own page, which navigates to localhost", reaches: "GET", attempts: ["deeper"],
                      html: { b in "<iframe src='\(b.own)/deeper/\(b.id)'></iframe>" },
                      pages: { b in ["/deeper/\(b.id)": b.ping + "<script>ping('deeper'); location.href = '\(b.machine)\(b.hit)'</script>"] }),
        FramedRequest(request: "sent through a chain of redirects into localhost", reaches: "GET", attempts: ["redirect"]) { b in
            "<script>ping('redirect'); location.href = '\(b.publicBase)/redirect/302?to=\(b.publicBase)/redirect/307?to=\(b.machine)\(b.hit)'</script>"
        },
        FramedRequest(request: "loading an image redirected into localhost", reaches: "GET", attempts: ["image"]) { b in
            "<img src='\(b.publicBase)/redirect/302?to=\(b.machine)\(b.hit)'><script>ping('image')</script>"
        },
        FramedRequest(request: "opening a websocket to localhost", reaches: "GET", attempts: ["socket"]) { b in
            "<script>new WebSocket('\(b.socket)\(b.hit)'); ping('socket')</script>"
        },
        FramedRequest(request: "sending a beacon to localhost", reaches: "POST", attempts: ["beacon"]) { b in
            "<script>ping('beacon'); navigator.sendBeacon('\(b.machine)\(b.hit)', 'a')</script>"
        },
        FramedRequest(request: "starting a worker that fetches localhost", reaches: "GET", attempts: ["worker", "worker-ran"],
                      html: { b in "<script>new Worker('/worker/\(b.id).js'); ping('worker')</script>" },
                      pages: { b in ["/worker/\(b.id).js": workerScript(b)] }),
        FramedRequest(request: "starting a blob worker that fetches localhost", reaches: "GET", attempts: ["worker", "worker-ran"]) { b in
            let code = workerScript(b).replacingOccurrences(of: "\"", with: "\\\"")
            return "<script>new Worker(URL.createObjectURL(new Blob([\"\(code)\"], { type: 'text/javascript' }))); ping('worker')</script>"
        },
    ]

    /// A worker's script: it asks the machine, then reports that it ran.
    private static func workerScript(_ b: Bases) -> String {
        "fetch('\(b.machine)\(b.hit)').catch(() => {}); fetch('\(b.publicBase)/ran/\(b.id)/worker-ran', { mode: 'no-cors' }).catch(() => {});"
    }
}

extension PageRulesScenario {
    /// Every framed request, from a public frame and from a localhost one.
    static let framedRequests: [PageRulesScenario] = [Origin.publicSite, .loopback].flatMap { origin in
        FramedRequest.all.map { $0.scenario(origin) }
    }
}
#endif
