import SwiftUI
import UniformTypeIdentifiers

/// What a page waits on the person for, as the system's own alerts: its alert, confirm or
/// prompt; a site's sign-in (sent only to that site's browser, never kept); and its file picker,
/// answered with files from this phone. Until answered, the page takes nothing else, from the
/// person or an agent. A prompt from a tab not shown says so.
struct BrowserPrompts: ViewModifier {
    @Bindable var model: ClientModel
    @State private var answered: Set<String> = []
    @State private var promptText = ""
    @State private var username = ""
    @State private var password = ""
    @State private var picking: BrowserViewInfo.Chooser?
    @State private var staging = false

    private var state: BrowserViewInfo.State? { model.browser.view?.state }
    private var dialog: BrowserViewInfo.Dialog? { open(state?.dialog, \.id) }
    private var signIn: BrowserViewInfo.SignIn? { open(state?.auth, \.id) }
    private var chooser: BrowserViewInfo.Chooser? { picking == nil ? open(state?.chooser, \.id) : nil }

    func body(content: Content) -> some View {
        content
            .alert(dialogTitle, isPresented: shown(dialog?.id), presenting: dialog) { dialog in
                if dialog.type == "prompt" {
                    TextField("Answer", text: $promptText).accessibilityIdentifier("browser.dialog.answer")
                }
                switch dialog.type {
                case "beforeunload":
                    Button("Stay", role: .cancel) { answer(dialog, false) }
                    Button("Leave page") { answer(dialog, true) }
                case "confirm", "prompt":
                    Button("Cancel", role: .cancel) { answer(dialog, false) }
                    Button("OK") { answer(dialog, true) }
                default:
                    Button("OK") { answer(dialog, true) }
                }
            } message: { dialog in
                Text(dialog.message.isEmpty && dialog.type == "beforeunload" ? "Leave this page?" : dialog.message)
            }
            .alert(signInTitle, isPresented: shown(signIn?.id), presenting: signIn) { challenge in
                TextField("Username", text: $username).textContentType(.username).textInputAutocapitalization(.never)
                SecureField("Password", text: $password).textContentType(.password)
                Button("Cancel", role: .cancel) {
                    answered.insert(challenge.id)
                    model.browserSignIn(challenge, username: nil, password: nil)
                }
                Button("Sign in") {
                    answered.insert(challenge.id)
                    model.browserSignIn(challenge, username: username, password: password)
                    username = ""; password = ""
                }
            } message: { challenge in
                Text(challenge.realm.map { "“\($0)” on this site. It goes only to the site; ace doesn't keep it." } ?? "It goes only to the site; ace doesn't keep it.")
            }
            .alert(chooserTitle, isPresented: shown(chooser?.id), presenting: chooser) { chooser in
                Button("Cancel", role: .cancel) {
                    answered.insert(chooser.id)
                    model.browserFiles(chooser, [])
                }
                Button(chooser.multiple ? "Choose files" : "Choose file") { picking = chooser }
            }
            .fileImporter(isPresented: Binding(get: { picking != nil }, set: { if !$0 && !staging { cancelPicking() } }),
                          allowedContentTypes: [.item], allowsMultipleSelection: picking?.multiple ?? false) { result in
                guard let chooser = picking else { return }
                switch result {
                case .success(let urls): stage(urls, for: chooser)
                case .failure: cancelPicking()
                }
            }
            .onChange(of: state?.dialog?.id) { promptText = state?.dialog?.defaultPrompt ?? "" }
            .onChange(of: state?.chooser?.id) { _, now in if now == nil { model.browser.clearUpload() } }
            .safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) {
                if let upload = model.browser.upload {
                    ProgressView("Sending files to the page", value: upload.progress)
                        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                        .padding(.horizontal, AceTheme.Spacing.xl).padding(.vertical, AceTheme.Spacing.sm)
                }
            }
    }

    /// A prompt the person hasn't answered yet; a view-only grant answers none.
    private func open<T>(_ value: T?, _ id: KeyPath<T, String>) -> T? {
        guard model.canOperate, let value, !answered.contains(value[keyPath: id]) else { return nil }
        return value
    }
    private func shown(_ id: String?) -> Binding<Bool> {
        Binding(get: { id != nil }, set: { _ in })
    }
    private var dialogTitle: String {
        guard let dialog else { return "" }
        return "\(dialog.site)\(dialog.otherTab ? " (another tab)" : "") asks"
    }
    private var signInTitle: String {
        guard let signIn else { return "" }
        return "Sign in to \(signIn.site)\(signIn.otherTab ? " (another tab)" : "")"
    }
    private var chooserTitle: String {
        guard let chooser else { return "" }
        return "\(chooser.site)\(chooser.otherTab ? " (another tab)" : "") asks for \(chooser.multiple ? "files" : "a file")"
    }
    private func answer(_ dialog: BrowserViewInfo.Dialog, _ accept: Bool) {
        answered.insert(dialog.id)
        model.browserAnswer(dialog, accept: accept, text: dialog.type == "prompt" && accept ? promptText : nil)
    }
    private func cancelPicking() {
        guard let chooser = picking else { return }
        picking = nil
        answered.insert(chooser.id)
        model.browserFiles(chooser, [])
    }
    /// Copies and hashes the picked files off the main actor, then sends them up for the page.
    private func stage(_ urls: [URL], for chooser: BrowserViewInfo.Chooser) {
        staging = true
        answered.insert(chooser.id)
        Task {
            let files = await Task.detached(priority: .userInitiated) {
                urls.prefix(16).compactMap { url -> StagedAttachment? in
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    let type = UTType(filenameExtension: url.pathExtension)
                    return try? AttachmentStaging().stage(copying: url, name: url.lastPathComponent,
                                                          mimeType: type?.preferredMIMEType ?? "application/octet-stream")
                }
            }.value
            picking = nil
            staging = false
            model.browserFiles(chooser, files)
        }
    }
}

extension View {
    func browserPrompts(model: ClientModel) -> some View { modifier(BrowserPrompts(model: model)) }
}
