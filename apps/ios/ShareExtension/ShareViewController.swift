import SwiftUI
import UIKit

/// The share sheet's ace: a compact sheet that queues a start for the app and opens it. The
/// extension can't run the shared runtime, so it never claims to have started anything: Send
/// saves the handoff in the app group, then opens ace, which starts it from New thread.
final class ShareViewController: UIViewController {
    private let model = ShareModel(store: HandoffStore.shared())

    override func viewDidLoad() {
        super.viewDidLoad()
        let model = self.model
        let host = UIHostingController(rootView: ShareView(model: model, cancel: { [weak self] in self?.finish() },
                                                           sent: { [weak self] url in self?.open(url) }))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        Task { @MainActor in model.shared(await SharedItems.read(items)) }
    }

    private func finish() { extensionContext?.completeRequest(returningItems: nil) }

    /// Opens ace on its handoff link through the app that hosts the share sheet. When that isn't
    /// possible, the handoff waits and starts the next time ace opens; the sheet says so.
    private func open(_ url: URL) {
        // Extensions may not call UIApplication's API directly; the hosting app's own object is
        // reached through the responder chain and asked by selector.
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let next = responder, !next.responds(to: selector) { responder = next.next }
        guard let application = responder, let method = class_getInstanceMethod(type(of: application), selector) else {
            model.waiting = true
            return
        }
        typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, @convention(block) (Bool) -> Void) -> Void
        let call = unsafeBitCast(method_getImplementation(method), to: Open.self)
        call(application, selector, url as NSURL, NSDictionary(), { [weak self] opened in
            Task { @MainActor in if opened { self?.finish() } else { self?.model.waiting = true } }
        })
    }
}

/// What the share sheet shows and sends.
@MainActor @Observable final class ShareModel {
    let store: HandoffStore?
    let catalogue: HandoffCatalogue
    var project: HandoffCatalogue.Project?
    var text = ""
    var images: [(data: Data, name: String, mimeType: String)] = []
    var reading = true
    /// Saved, but ace couldn't be opened from here: it starts when ace is next opened.
    var waiting = false
    var problem: String?

    init(store: HandoffStore?) {
        self.store = store
        catalogue = store?.catalogue() ?? HandoffCatalogue()
        project = catalogue.suggested
    }
    func shared(_ items: SharedItems) {
        text = items.text
        images = items.images
        reading = false
    }
    var canSend: Bool { !reading && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty) }

    /// Queues the handoff; the link that opens ace on it, or nil with `problem` set.
    func send(now: Date) -> URL? {
        guard let store else { problem = "ace can't take shares on this phone yet. Open ace once, then share again."; return nil }
        let handoff = Handoff(id: UUID().uuidString.lowercased(), created: now, machineId: project?.machineId,
                              projectId: project?.projectId, text: text.trimmingCharacters(in: .whitespacesAndNewlines), source: .share)
        do { try store.add(handoff, files: images) } catch {
            problem = "Couldn't keep that on this phone. Try again."
            return nil
        }
        return URL(string: "ace://new")
    }
}
