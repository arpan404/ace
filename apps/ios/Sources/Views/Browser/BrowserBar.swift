import SwiftUI

/// The browser's bottom bar, as Safari's: Back and Forward, the address (tap to type another),
/// the tabs with their count, and the ⋯ menu, each on glass.
struct BrowserBar: View {
    @Bindable var model: ClientModel
    @Binding var editing: Bool
    @Binding var sheet: BrowserSheet?
    @Binding var finding: Bool
    let screenshot: (Bool) -> Void

    private var state: BrowserViewInfo.State? { model.browser.view?.state }
    private var operate: Bool { model.canOperate && state?.closed != true }

    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            HStack(spacing: AceTheme.Spacing.none) {
                barButton("Back", .caretLeft, enabled: operate && (state?.shown?.canGoBack == true || state?.failure != nil)) {
                    model.browserHistory("back")
                }
                .accessibilityIdentifier("browser.back")
                barButton("Forward", .caretRight, enabled: operate && state?.shown?.canGoForward == true) {
                    model.browserHistory("forward")
                }
                .accessibilityIdentifier("browser.forward")
            }
            .aceGlass(in: Capsule(), interactive: true)
            address
            HStack(spacing: AceTheme.Spacing.none) {
                Button { sheet = .tabs } label: {
                    TabCount(count: (state?.tabs.count ?? 0) + (state?.moreTabs ?? 0))
                        .frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Tabs")
                .accessibilityValue("\(state?.tabs.count ?? 0)")
                .accessibilityIdentifier("browser.tabs")
                BrowserMenu(model: model, sheet: $sheet, finding: $finding, screenshot: screenshot)
            }
            .aceGlass(in: Capsule(), interactive: true)
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.top, AceTheme.Spacing.sm)
        .padding(.bottom, AceTheme.Spacing.xs)
    }

    /// The page's address at rest; a spinner while it loads, Reload or Stop beside it.
    private var address: some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            Button { if operate || state == nil || state?.closed == true { editing = model.canOperate } } label: {
                HStack(spacing: AceTheme.Spacing.xs) {
                    if state?.loading == true {
                        ProgressView().controlSize(.mini)
                    }
                    Text(addressText)
                        .foregroundStyle(addressText == Self.prompt ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .aceFont(AceTheme.Typography.label, relativeTo: .body).fontWeight(.regular)
                .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget)
                .padding(.leading, AceTheme.Spacing.md)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Address")
            .accessibilityValue(addressText)
            .accessibilityIdentifier("browser.address")
            if operate, state?.blank == false {
                if state?.loading == true {
                    barButton("Stop", .x, enabled: true) { model.browserHistory("stop") }
                } else {
                    barButton("Reload", .arrowClockwise, enabled: true) { model.browserHistory("reload") }
                        .accessibilityIdentifier("browser.reload")
                }
            }
        }
        .aceGlass(in: Capsule(), interactive: true)
    }
    private static let prompt = "Search or enter address"
    private var addressText: String {
        guard let state, !state.closed, let address = state.address, !address.isEmpty else { return Self.prompt }
        if let host = state.addressHost, !host.isEmpty { return host }
        return address
    }

    private func barButton(_ label: String, _ icon: AceIcon.Name, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            AceIcon(icon, size: 17, relativeTo: .subheadline)
                .frame(width: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.xs, height: AceTheme.Dimensions.touchTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(AceTheme.Colours.foreground)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
        .accessibilityLabel(label)
    }
}

/// The tabs button: the count in a rounded square, as Safari draws it.
private struct TabCount: View {
    let count: Int
    var body: some View {
        Text(count > 99 ? "∞" : "\(count)")
            .font(.system(size: 12, weight: .semibold, design: .rounded))
            .monospacedDigit()
            .frame(width: 20, height: 20)
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(AceTheme.Colours.foreground, lineWidth: 1.6))
            .foregroundStyle(AceTheme.Colours.foreground)
    }
}

/// Typing an address: a field over the keyboard, Go to open it in the shown tab.
struct BrowserAddressEditor: View {
    @Bindable var model: ClientModel
    @Binding var editing: Bool
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            Color.black.opacity(0.25)
                .ignoresSafeArea()
                .onTapGesture { editing = false }
                .accessibilityHidden(true)
            HStack(spacing: AceTheme.Spacing.md) {
                HStack(spacing: AceTheme.Spacing.sm) {
                    AceIcon(.magnifyingGlass).foregroundStyle(AceTheme.Colours.mutedForeground)
                    TextField("Search or enter address", text: $text)
                        .focused($focused)
                        .keyboardType(.webSearch)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit(go)
                        .accessibilityIdentifier("browser.address.field")
                    if !text.isEmpty {
                        Button { text = "" } label: { AceIcon(.xCircle) }
                            .foregroundStyle(AceTheme.Colours.subtleForeground)
                            .accessibilityLabel("Clear")
                    }
                }
                .aceFont(AceTheme.Typography.body, relativeTo: .body)
                .padding(.horizontal, AceTheme.Spacing.lg)
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
                .aceGlass(in: Capsule())
                Button("Cancel") { editing = false }
                    .aceFont(AceTheme.Typography.label, relativeTo: .body)
                    .tint(AceTheme.Colours.foreground)
            }
            .padding(.horizontal, AceTheme.Spacing.md)
            .padding(.vertical, AceTheme.Spacing.sm)
            .background(AceTheme.Colours.background)
        }
        .onAppear {
            text = model.browser.view?.state?.addressUrl ?? ""
            focused = true
        }
    }
    private func go() {
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        editing = false
        guard !typed.isEmpty else { return }
        model.browserGo(typed)
    }
}

/// Find in page, in place of the bar: the words, the count, previous and next.
struct BrowserFindBar: View {
    @Bindable var model: ClientModel
    let close: () -> Void
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            HStack(spacing: AceTheme.Spacing.sm) {
                TextField("Find in page", text: $text)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .onSubmit { model.browserFind(text) }
                    .accessibilityIdentifier("browser.find.field")
                if let result = model.browser.find, result.text == text, !text.isEmpty {
                    Text(result.message).foregroundStyle(AceTheme.Colours.mutedForeground).monospacedDigit()
                        .accessibilityIdentifier("browser.find.count")
                }
            }
            .aceFont(AceTheme.Typography.body, relativeTo: .body)
            .padding(.horizontal, AceTheme.Spacing.lg)
            .frame(minHeight: AceTheme.Dimensions.touchTarget)
            .aceGlass(in: Capsule())
            HStack(spacing: AceTheme.Spacing.none) {
                Button { model.browserFind(text, forward: false) } label: {
                    AceIcon(.caretUp).frame(width: 40, height: AceTheme.Dimensions.touchTarget)
                }
                .accessibilityLabel("Previous match")
                Button { model.browserFind(text) } label: {
                    AceIcon(.caretDown).frame(width: 40, height: AceTheme.Dimensions.touchTarget)
                }
                .accessibilityLabel("Next match")
            }
            .disabled(text.isEmpty)
            .aceGlass(in: Capsule(), interactive: true)
            Button("Done") { finish() }
                .aceFont(AceTheme.Typography.label, relativeTo: .body).fontWeight(.semibold)
        }
        .tint(AceTheme.Colours.foreground)
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.Spacing.sm)
        .onAppear { focused = true }
        .task(id: text) {
            guard !text.isEmpty else { return }
            try? await Task.sleep(for: .milliseconds(200))
            if !Task.isCancelled { model.browserFind(text) }
        }
    }
    private func finish() {
        model.browserFind("")
        model.browser.clearFind()
        close()
    }
}
