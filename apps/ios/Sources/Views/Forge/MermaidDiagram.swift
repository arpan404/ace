import UIKit
import WebKit

/// Mermaid diagrams in GitHub text, drawn offline for markit's `renderDiagram`: the bundled
/// mermaid (copied into the app by `bun run generate`) runs in a web view that may load nothing
/// (a `default-src` CSP of `none`) and takes no touches. The view is handed to markit only once
/// the diagram is drawn, at the size it drew, so the block never jumps; until then, and when it
/// can't be drawn, markit shows the diagram's code.
@MainActor enum MermaidDiagram {
    private static let library: String? = Bundle.main.url(forResource: "mermaid", withExtension: "js")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }

    /// The drawn diagram, or nil when it can't be drawn within a few seconds.
    static func render(_ source: String, dark: Bool) async -> UIView? {
        guard let library, let json = try? JSONEncoder().encode(source),
              // `</` can't end the page's script from inside the diagram's text.
              let text = String(data: json, encoding: .utf8)?.replacingOccurrences(of: "</", with: "<\\/") else { return nil }
        let view = MermaidDiagramView(library: library)
        guard await view.draw(page(text, dark: dark)) else { return nil }
        return view
    }

    private static func page(_ source: String, dark: Bool) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
        <style>html,body{margin:0;padding:0;background:transparent;color-scheme:light dark}svg{max-width:100%;height:auto;display:block}</style>
        </head><body><div id="d"></div>
        <script>mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'\(dark ? "dark" : "default")'});
        mermaid.render('m',\(source)).then(r=>{const d=document.getElementById('d');d.innerHTML=r.svg;
        const b=d.firstElementChild.getBoundingClientRect();webkit.messageHandlers.diagram.postMessage([b.width,b.height])})
        .catch(()=>webkit.messageHandlers.diagram.postMessage([0,0]));</script>
        </body></html>
        """
    }
}

/// A drawn diagram at the size it drew; markit scales it down to a narrower column.
final class MermaidDiagramView: UIView {
    /// Wide enough that a diagram is laid out at its own width.
    private static let layoutWidth: CGFloat = 640
    private let web: WKWebView
    private let messages: Messages
    private var drawn = CGSize.zero
    private var waiting: CheckedContinuation<Bool, Never>?

    init(library: String) {
        messages = Messages()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(messages, name: "diagram")
        configuration.userContentController.addUserScript(WKUserScript(source: library, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: CGRect(x: 0, y: 0, width: Self.layoutWidth, height: 400), configuration: configuration)
        super.init(frame: web.frame)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false
        web.isUserInteractionEnabled = false
        addSubview(web)
        messages.owner = self
        isAccessibilityElement = true
        accessibilityLabel = "Diagram"
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Loads the page and waits for the diagram; false when it failed or took too long.
    func draw(_ html: String) async -> Bool {
        // A web view outside any window may not run its page; it draws out of sight in the app's
        // window, then markit places it.
        let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first { $0.isKeyWindow }
        if let window {
            frame = CGRect(x: -Self.layoutWidth * 2, y: 0, width: Self.layoutWidth, height: 400)
            alpha = 0
            window.addSubview(self)
        }
        defer {
            if window != nil { removeFromSuperview(); alpha = 1 }
        }
        web.loadHTMLString(html, baseURL: nil)
        let timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            self?.finish(.zero)
        }
        defer { timeout.cancel() }
        return await withCheckedContinuation { waiting = $0 }
    }

    fileprivate func finish(_ size: CGSize) {
        guard let waiting else { return }
        self.waiting = nil
        drawn = size
        invalidateIntrinsicContentSize()
        waiting.resume(returning: size.width > 0 && size.height > 0)
    }

    override var intrinsicContentSize: CGSize { drawn }

    override func layoutSubviews() {
        super.layoutSubviews()
        web.frame = bounds
    }

    /// Receives the page's size report without the page's controller holding the view.
    private final class Messages: NSObject, WKScriptMessageHandler {
        weak var owner: MermaidDiagramView?

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            let numbers = (message.body as? [NSNumber])?.map { CGFloat($0.doubleValue) } ?? []
            let size = numbers.count == 2 ? CGSize(width: ceil(numbers[0]), height: ceil(min(numbers[1], 4000))) : .zero
            MainActor.assumeIsolated { owner?.finish(size) }
        }
    }
}
