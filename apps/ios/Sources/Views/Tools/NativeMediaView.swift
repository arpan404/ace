import SwiftUI
import WebKit

private struct NativeMediaReply: Decodable { let kind: String; let document: String?; let data: String? }

/// Published media is read through the owning SDK connection. HTML uses the same opaque-origin
/// sandbox as the desktop, in a separate, nonpersistent WebKit store with no native handlers.
/// With `attachment`, it shows that image of the person's message `item` instead.
struct NativeMediaView: View {
    let model: ClientModel
    let threadId: String
    let item: TranscriptRow
    var attachment: AttachmentLine? = nil
    private var title: String { attachment.map { $0.name.isEmpty ? "Image" : $0.name } ?? item.text }
    private var request: [String: Any] {
        if let attachment {
            return ["type": "native.attachment", "threadId": threadId, "itemId": item.id, "ref": attachment.ref ?? "", "variant": "original"]
        }
        return ["type": "native.media", "threadId": threadId, "itemId": item.id, "scheme": scheme == .dark ? "dark" : "light"]
    }
    @Environment(\.colorScheme) private var scheme
    @State private var document: String?
    @State private var picture: UIImage?
    @State private var problem: String?
    var body: some View {
        Group {
            if let document { SandboxedCanvas(document: document) }
            else if let picture { ScrollView([.horizontal, .vertical]) { Image(uiImage: picture).resizable().scaledToFit().accessibilityLabel(title) } }
            else if let problem { ContentUnavailableView("Couldn't open media", systemImage: "doc", description: Text(problem)) }
            else { ProgressView("Loading…") }
        }
        .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        .task(id: scheme) {
            do {
                let reply = try await model.service(request, as: NativeMediaReply.self)
                if reply.kind == "html", let html = reply.document { document = html }
                else if let encoded = reply.data, let data = Data(base64Encoded: encoded), let image = UIImage(data: data) { picture = image }
                else { throw ServiceFailure(message: "The attachment couldn't be decoded.") }
                problem = nil
            } catch { if !Task.isCancelled { problem = error.localizedDescription } }
        }
    }
}
struct SandboxedCanvas: UIViewRepresentable {
    let document: String
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.accessibilityIdentifier = "canvas.content"
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.loadedDocument != document else { return }
        context.coordinator.loadedDocument = document
        view.loadHTMLString(document, baseURL: nil)
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedDocument = ""
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let scheme = navigationAction.request.url?.scheme
            decisionHandler(scheme == "about" || scheme == "data" ? .allow : .cancel)
        }
    }
}
