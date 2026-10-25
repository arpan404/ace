import SwiftUI
import WebKit

/// A small offline web view for what UIKit can't draw itself: SVG images, WebM video and mermaid
/// diagrams. The page is static HTML with every network request refused (a `default-src` CSP of
/// `none`; images, media and scripts only from the page itself), and it reports its content
/// height so it sits inline at its own size.
struct ForgeWebSnippet: UIViewRepresentable {
    let html: String
    @Binding var height: CGFloat
    /// A script run before the page's own (mermaid), kept out of the page's text.
    var library: String?

    func makeCoordinator() -> Coordinator { Coordinator(height: $height) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        configuration.userContentController.add(context.coordinator, name: "height")
        if let library {
            configuration.userContentController.addUserScript(WKUserScript(source: library, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.navigationDelegate = context.coordinator
        view.loadHTMLString(Self.document(html), baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.loaded != html else { return }
        context.coordinator.loaded = html
        view.loadHTMLString(Self.document(html), baseURL: nil)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "height")
    }

    /// The page around `body`: no network, transparent, and its height posted on every resize.
    static func document(_ body: String) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data: blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
        <style>html,body{margin:0;padding:0;background:transparent;color-scheme:light dark}img,video,svg{max-width:100%;height:auto;display:block}</style>
        </head><body>\(body)
        <script>new ResizeObserver(()=>webkit.messageHandlers.height.postMessage(document.body.scrollHeight)).observe(document.body)</script>
        </body></html>
        """
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var height: Binding<CGFloat>
        var loaded: String?
        init(height: Binding<CGFloat>) { self.height = height }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let value = message.body as? Double, value > 0 else { return }
            let next = CGFloat(min(value, 4000))
            if abs(height.wrappedValue - next) > 1 { height.wrappedValue = next }
        }

        /// The page itself only: links never navigate inside it.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            action.navigationType == .other ? .allow : .cancel
        }
    }
}

/// A mermaid diagram drawn offline by the bundled mermaid (copied into the app by `bun run
/// generate`), in the scheme on screen; its source shows when the diagram can't be drawn.
struct ForgeMermaidView: View {
    let source: String
    @Environment(\.colorScheme) private var scheme
    @State private var height: CGFloat = 120

    private static let library: String? = Bundle.main.url(forResource: "mermaid", withExtension: "js")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }

    var body: some View {
        if let library = Self.library, let json = try? JSONEncoder().encode(source),
           // `</` can't end the page's script from inside the diagram's text.
           let text = String(data: json, encoding: .utf8)?.replacingOccurrences(of: "</", with: "<\\/") {
            ForgeWebSnippet(html: """
                <div id="d"></div>
                <script>mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'\(scheme == .dark ? "dark" : "default")'});
                mermaid.render('m',\(text)).then(r=>{document.getElementById('d').innerHTML=r.svg}).catch(()=>{document.getElementById('d').textContent='This diagram couldn\\'t be drawn.'});</script>
                """, height: $height, library: library)
                .frame(height: height)
                .accessibilityLabel("Diagram")
        } else {
            MarkdownCodeBlock(language: "mermaid", text: source)
        }
    }
}
