/// One Files screen's place in the bridge's count of screens showing a scope's tree
/// (`files.tree.show` / `files.tree.hide`). Held in the screen's State, so the screen leaving the
/// navigation stack (a pop, or a breadcrumb's Files screen going back) gives its show back, and
/// the checkout watch stops once no screen shows the tree.
@MainActor final class FilesTreeWatch {
    private var hide: (@MainActor @Sendable () -> Void)?
    var isShown: Bool { hide != nil }

    func show(_ model: ClientModel, _ scope: FilesScope) {
        guard hide == nil else { return }
        model.showFilesTree(scope)
        hide = { model.hideFilesTree(scope) }
    }

    func stop() {
        hide?()
        hide = nil
    }

    deinit {
        if let hide { Task { @MainActor in hide() } }
    }
}
