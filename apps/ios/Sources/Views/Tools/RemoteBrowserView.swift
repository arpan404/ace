import SwiftUI

private struct BrowserReply: Decodable {
    let ok: Bool
    let error: String?
    let result: ServiceValue?
    func checked<T: Decodable>(_ type: T.Type) throws -> T {
        guard ok, let result else { throw ServiceFailure(message: error ?? "Browser unavailable") }
        return try result.decode(type)
    }
}
private struct BrowserTabs: Decodable {
    struct Tab: Decodable, Identifiable { let tabId: String; let title: String; let url: String; var id: String { tabId } }
    let tabs: [Tab]
}
private struct BrowserPicture: Decodable { let data: String? }
private struct BrowserViewport: Decodable { let width: Double; let height: Double }
struct RemoteBrowserView: View {
    let model: ClientModel
    let threadId: String
    @State private var tabs: [BrowserTabs.Tab] = []
    @State private var tabId = ""
    @State private var address = ""
    @State private var words = ""
    @State private var image: UIImage?
    @State private var viewport: BrowserViewport?
    @State private var problem: String?
    @State private var busy = false
    var body: some View {
        VStack(spacing: AceTheme.Spacing.sm) {
            HStack {
                TextField("Website address", text: $address).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    .onSubmit { navigate() }
                Button("Go", action: navigate).disabled(!model.canOperate || busy || address.isEmpty)
            }
            if !tabs.isEmpty {
                Picker("Browser tab", selection: $tabId) {
                    ForEach(tabs) { Text($0.title.isEmpty ? $0.url : $0.title).tag($0.id) }
                }.onChange(of: tabId) { _, id in
                    if let selected = tabs.first(where: { $0.id == id }) { address = selected.url }
                    Task { await capture() }
                }
            }
            HStack {
                Button("Back", systemImage: "chevron.left") { perform(["action": "history", "direction": "back"]) }.disabled(!model.canOperate || tabId.isEmpty)
                Button("Forward", systemImage: "chevron.right") { perform(["action": "history", "direction": "forward"]) }.disabled(!model.canOperate || tabId.isEmpty)
                Spacer()
                Button("Refresh preview", systemImage: "arrow.clockwise") { Task { await capture() } }
            }.disabled(busy)
            ServiceProblem(message: problem)
            if busy { ProgressView("Updating browser…") }
            if let image {
                GeometryReader { geometry in
                    let fit = min(geometry.size.width / image.size.width, geometry.size.height / image.size.height)
                    Image(uiImage: image).resizable().scaledToFit()
                        .frame(width: image.size.width * fit, height: image.size.height * fit)
                        .onTapGesture { point in
                            guard model.canOperate, let viewport else { return }
                            perform(["action": "click", "x": point.x / (image.size.width * fit) * viewport.width, "y": point.y / (image.size.height * fit) * viewport.height])
                        }
                        .accessibilityLabel("Remote browser preview")
                        .accessibilityHint("Tap to click on the machine")
                }
            } else { ContentUnavailableView("Browser preview", systemImage: "globe", description: Text("Open a website on your machine.")) }
            HStack {
                Button("Scroll up", systemImage: "arrow.up") { perform(["action": "scroll", "x": 0, "y": -500]) }
                Button("Scroll down", systemImage: "arrow.down") { perform(["action": "scroll", "x": 0, "y": 500]) }
                TextField("Type into focused field", text: $words).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Type") { typeWords() }
                Button("Enter") { perform(["action": "press", "key": "Enter"]) }
            }.disabled(!model.canOperate || busy || tabId.isEmpty)
        }
        .padding(AceTheme.Spacing.lg)
        .navigationTitle("Browser").navigationBarTitleDisplayMode(.inline)
        .task { await read() }
    }
    private func read() async {
        do {
            var reply = try await model.service(["type": "browser.tabs.list", "threadId": threadId], as: BrowserReply.self)
            if model.canOperate, (!reply.ok || (try? reply.checked([BrowserTabs.Tab].self).isEmpty) == true), let workspace = model.thread?.metadata?.workspaceId {
                let opened = try await model.service(["type": "browser.open", "options": ["threadId": threadId, "workspaceId": workspace]], as: BrowserReply.self)
                guard opened.ok else { throw ServiceFailure(message: opened.error ?? "Couldn't open browser") }
                reply = try await model.service(["type": "browser.tabs.list", "threadId": threadId], as: BrowserReply.self)
            }
            tabs = try reply.checked([BrowserTabs.Tab].self)
            if tabId.isEmpty, let first = tabs.first { tabId = first.id; address = first.url }
            await capture()
        } catch { problem = error.localizedDescription }
    }
    private func capture() async {
        guard !tabId.isEmpty else { return }
        let capturedTab = tabId
        do {
            // Evaluation requires operate even in its read-only mode. A view-only phone
            // needs only the read-authorized screenshot; it cannot send point clicks.
            let dimensions: BrowserViewport?
            if model.canOperate {
                let geometry = try await execute(["action": "evaluate", "mode": "read-only", "expression": "({width: innerWidth, height: innerHeight})"], tab: capturedTab)
                dimensions = try geometry.checked(BrowserViewport.self)
            } else { dimensions = nil }
            let screenshot = try await execute(["action": "screenshot"], tab: capturedTab)
            let picture = try screenshot.checked(BrowserPicture.self)
            guard let encoded = picture.data, let data = Data(base64Encoded: encoded), let decoded = UIImage(data: data) else { throw ServiceFailure(message: "Preview unavailable. Try refreshing the page.") }
            guard capturedTab == tabId, !Task.isCancelled else { return }
            viewport = dimensions; image = decoded; problem = nil
        } catch { if capturedTab == tabId, !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func execute(_ command: [String: Any], tab: String? = nil) async throws -> BrowserReply {
        var command = command
        let target = tab ?? tabId
        if !target.isEmpty { command["tabId"] = target }
        let reply = try await model.service(["type": "browser.execute", "threadId": threadId, "command": command], as: BrowserReply.self)
        guard reply.ok else { throw ServiceFailure(message: reply.error ?? "Browser request refused") }
        return reply
    }
    private func perform(_ command: [String: Any]) {
        guard model.canOperate, !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do { _ = try await execute(command); await capture() }
            catch { problem = error.localizedDescription }
        }
    }
    private func navigate() {
        let url = address.contains("://") ? address : "https://\(address)"
        perform(["action": "navigate", "url": url])
    }
    private func typeWords() {
        guard model.canOperate, !words.isEmpty, !busy else { return }
        let text = words
        busy = true
        Task {
            defer { busy = false }
            do {
                var remaining = text[...]
                while !remaining.isEmpty {
                    let chunk = String(remaining.prefix(64))
                    let reply = try await model.service(["type": "browser.input", "threadId": threadId, "tabId": tabId, "input": ["kind": "key", "event": "char", "key": "Unidentified", "text": chunk]], as: BrowserReply.self)
                    guard reply.ok else { throw ServiceFailure(message: reply.error ?? "Typing refused") }
                    remaining = remaining.dropFirst(chunk.count)
                }
                if words == text { words = "" }
                await capture()
            } catch { problem = error.localizedDescription }
        }
    }
}
