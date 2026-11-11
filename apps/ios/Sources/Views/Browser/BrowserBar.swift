import SwiftUI

/// The browser's bottom bar, as Safari's: Back and Forward, the address (tap to type another),
/// the tabs with their count, and the ⋯ menu, each on glass.
struct BrowserBar: View {
    @Bindable var model: ClientModel
    @Binding var editing: Bool
    @Binding var sheet: BrowserSheet?
    @Binding var finding: Bool
    @Binding var clearing: Bool
    /// iPad: the tab beside the live one; nil where there's no room for a split.
    var split: Binding<String?>? = nil
    let screenshot: (Bool) -> Void

    private var state: BrowserViewInfo.State? { model.browser.view?.state }
    private var operate: Bool { model.canOperate && state?.closed != true }

    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
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
            .aceGlass(in: AceDesign.Shape.control, interactive: true)
            address
            HStack(spacing: AceTheme.Spacing.none) {
                Button { sheet = .tabs } label: {
                    TabCount(count: (state?.tabs.count ?? 0) + (state?.moreTabs ?? 0))
                        .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Tabs")
                .accessibilityValue("\(state?.tabs.count ?? 0)")
                .accessibilityIdentifier("browser.tabs")
                BrowserMenu(model: model, sheet: $sheet, finding: $finding, clearing: $clearing, split: split, screenshot: screenshot)
            }
            .aceGlass(in: AceDesign.Shape.control, interactive: true)
        }
        .padding(.horizontal, AceDesign.Space.row)
        .padding(.top, AceDesign.Space.related)
        .padding(.bottom, AceDesign.Space.tight)
    }

    /// The page's address at rest; a spinner while it loads, Reload or Stop beside it.
    private var address: some View {
        HStack(spacing: AceDesign.Space.tight) {
            Button { if operate || state == nil || state?.closed == true { editing = model.canOperate } } label: {
                HStack(spacing: AceDesign.Space.tight) {
                    if state?.loading == true {
                        WorkingMark(label: "Loading")
                    }
                    Text(addressText)
                        .foregroundStyle(addressText == Self.prompt ? AceDesign.Ink.muted : AceDesign.Ink.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .font(AceDesign.Typeface.body).fontWeight(.regular)
                .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap)
                .padding(.leading, AceDesign.Space.row)
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
        .aceGlass(in: AceDesign.Shape.control, interactive: true)
    }
    private static let prompt = "Search or enter address"
    private var addressText: String {
        guard let state, !state.closed, let address = state.address, !address.isEmpty else { return Self.prompt }
        if let host = state.addressHost, !host.isEmpty { return host }
        return address
    }

    private func barButton(_ label: String, _ icon: AceIcon.Name, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            AceIcon(icon, size: AceDesign.Size.barIcon, relativeTo: .subheadline)
                .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(enabled ? AceDesign.Ink.primary : AceDesign.Ink.faint)
        .disabled(!enabled)
        .accessibilityLabel(label)
    }
}

/// The tabs button: the count in a rounded square, as Safari draws it.
private struct TabCount: View {
    let count: Int
    /// The glyph's own drawing: a count inside a bar icon's square, stroked like the other bar glyphs.
    private static let digits: CGFloat = 12
    private static let stroke: CGFloat = 1.6
    var body: some View {
        Text(count > 99 ? "∞" : "\(count)")
            .font(.system(size: Self.digits, weight: AceDesign.Typeface.strong, design: .rounded))
            .monospacedDigit()
            .frame(width: AceDesign.Size.barIcon, height: AceDesign.Size.barIcon)
            .overlay(AceShape.glyph.stroke(AceDesign.Ink.primary, lineWidth: Self.stroke))
            .foregroundStyle(AceDesign.Ink.primary)
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
            AceDesign.Surface.scrim
                .ignoresSafeArea()
                .onTapGesture { editing = false }
                .accessibilityHidden(true)
            HStack(spacing: AceDesign.Space.row) {
                HStack(spacing: AceDesign.Space.related) {
                    AceIcon(.magnifyingGlass).foregroundStyle(AceDesign.Ink.muted)
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
                            .foregroundStyle(AceDesign.Ink.subtle)
                            .accessibilityLabel("Clear")
                    }
                }
                .font(AceDesign.Typeface.title)
                .padding(.horizontal, AceDesign.Space.margin)
                .frame(minHeight: AceDesign.Size.tap)
                .aceGlass(in: AceDesign.Shape.control)
                Button("Cancel") { editing = false }
                    .font(AceDesign.Typeface.body)
                    .tint(AceDesign.Ink.accent)
            }
            .padding(.horizontal, AceDesign.Space.row)
            .padding(.vertical, AceDesign.Space.related)
            .background(AceDesign.Surface.background)
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
        HStack(spacing: AceDesign.Space.related) {
            HStack(spacing: AceDesign.Space.related) {
                TextField("Find in page", text: $text)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .onSubmit { model.browserFind(text) }
                    .accessibilityIdentifier("browser.find.field")
                if let result = model.browser.find, result.text == text, !text.isEmpty {
                    Text(result.message).foregroundStyle(AceDesign.Ink.muted).monospacedDigit()
                        .accessibilityIdentifier("browser.find.count")
                }
            }
            .font(AceDesign.Typeface.title)
            .padding(.horizontal, AceDesign.Space.margin)
            .frame(minHeight: AceDesign.Size.tap)
            .aceGlass(in: AceDesign.Shape.control)
            HStack(spacing: AceTheme.Spacing.none) {
                Button { model.browserFind(text, forward: false) } label: {
                    AceIcon(.caretUp).frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                }
                .accessibilityLabel("Previous match")
                Button { model.browserFind(text) } label: {
                    AceIcon(.caretDown).frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                }
                .accessibilityLabel("Next match")
            }
            .disabled(text.isEmpty)
            .aceGlass(in: AceDesign.Shape.control, interactive: true)
            Button("Done") { finish() }
                .font(AceDesign.Typeface.body).fontWeight(.semibold)
        }
        .tint(AceDesign.Ink.accent)
        .padding(.horizontal, AceDesign.Space.row)
        .padding(.vertical, AceDesign.Space.related)
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
