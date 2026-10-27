import SwiftUI
import UIKit

/// A finished page command, said once at the top of the page on glass ("PDF saved to this
/// thread"), gone after a few seconds or a tap.
struct BrowserDoneNote: View {
    @Bindable var model: ClientModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        ZStack {
            if let done = model.browser.done {
                Button { model.browser.done = nil } label: {
                    VStack(spacing: AceTheme.Spacing.xxs) {
                        Text(done.message).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                            .foregroundStyle(AceTheme.Colours.foreground)
                        if let detail = done.detail {
                            Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                                .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .aceGlass(in: AceShape.capsule)
                }
                .buttonStyle(.plain)
                .padding(.top, AceTheme.Spacing.sm)
                .transition(.opacity)
                .accessibilityIdentifier("browser.done")
                .task(id: done.at) {
                    try? await Task.sleep(for: .seconds(3))
                    if model.browser.done?.at == done.at { model.browser.done = nil }
                }
            }
        }
        .animation(reduceMotion ? nil : AceTheme.Motion.standardCurve, value: model.browser.done)
        .sensoryFeedback(.success, trigger: model.browser.done?.at) { _, new in new != nil }
    }
}

/// The shown page's source as the server sent it, readable on a phone: wrapped, monospaced,
/// selectable, to copy or share. Long sources are shortened and say so.
struct BrowserSourceSheet: View {
    @Bindable var model: ClientModel
    @State private var wrap = true
    var body: some View {
        NavigationStack {
            Group {
                if let source = model.browser.source {
                    SourceText(text: source.source, wrap: wrap)
                        .ignoresSafeArea(edges: .bottom)
                        .safeAreaInset(edge: .bottom) {
                            if source.truncated {
                                Text("Shortened: the page's source is longer.")
                                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                                    .frame(maxWidth: .infinity).padding(AceTheme.Spacing.sm)
                                    .background(AceTheme.Colours.background)
                            }
                        }
                        .transition(.opacity)
                } else {
                    SkeletonLines().transition(.opacity)
                }
            }
            .animation(AceTheme.Motion.standardCurve, value: model.browser.source == nil)
            .background(AceTheme.Colours.background)
            .navigationTitle("Page source").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose()
                if let source = model.browser.source {
                    ToolbarItemGroup(placement: .primaryAction) {
                        Button(wrap ? "Don't wrap lines" : "Wrap lines", ace: .textAlignLeft) { wrap.toggle() }
                        Button("Copy", ace: .copy) { UIPasteboard.general.string = source.source }
                        ShareLink(item: source.source, subject: Text(source.url))
                    }
                }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .presentationDetents([.large]).presentationDragIndicator(.visible)
        .onAppear { model.browserSource(open: true) }
        .onDisappear { model.browserSource(open: false) }
    }
}

/// A large read-only text, drawn by TextKit so a long source scrolls without laying it all out
/// in SwiftUI.
private struct SourceText: UIViewRepresentable {
    let text: String
    let wrap: Bool
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.font = UIFontMetrics(forTextStyle: .footnote).scaledFont(for: .monospacedSystemFont(ofSize: 12, weight: .regular))
        view.adjustsFontForContentSizeCategory = true
        view.textColor = UIColor(AceTheme.Colours.foreground)
        view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 24, right: 12)
        view.accessibilityIdentifier = "browser.source.text"
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
        view.textContainer.widthTracksTextView = wrap
        view.textContainer.size.width = wrap ? view.bounds.width : 100_000
        view.textContainer.lineBreakMode = wrap ? .byCharWrapping : .byClipping
        view.setNeedsLayout()
    }
}

/// Grey lines where text arrives, at the size the text will be.
private struct SkeletonLines: View {
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            ForEach(0..<8, id: \.self) { index in
                Capsule().fill(AceTheme.Colours.fill).frame(width: [220, 300, 180, 260, 140, 290, 200, 240][index], height: 12)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(AceTheme.Spacing.lg)
        .accessibilityLabel("Reading the page source")
    }
}

/// Screenshots of the shown page laid out at phone, tablet and desktop widths: choose the sizes,
/// take them, then look through and share each.
struct BrowserSizesSheet: View {
    @Bindable var model: ClientModel
    @State private var chosen: Set<String> = ["phone", "tablet", "desktop"]
    @State private var asked = false
    private static let sizes: [(id: String, title: String, width: Int)] = [("phone", "Phone", 390), ("tablet", "Tablet", 768), ("desktop", "Desktop", 1440)]
    var body: some View {
        NavigationStack {
            Group {
                if asked, let images = model.browser.sizes?.images, !images.isEmpty {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.xl) {
                            ForEach(images) { SizedShot(image: $0) }
                        }
                        .padding(AceTheme.Spacing.lg)
                    }
                    .transition(.opacity)
                } else if asked, model.browser.sizes?.images == nil {
                    VStack(spacing: AceTheme.Spacing.md) {
                        ProgressView()
                        Text("Laying the page out at each size").aceFont(AceTheme.Typography.body, relativeTo: .body)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .transition(.opacity)
                } else {
                    List {
                        Section {
                            ForEach(Self.sizes, id: \.id) { size in
                                Button { toggle(size.id) } label: {
                                    InsetRow(systemImage: nil, title: size.title, subtitle: "\(size.width) px wide") {
                                        if chosen.contains(size.id) { AceIcon(.check).foregroundStyle(AceTheme.Colours.foreground) }
                                    }
                                }
                                .buttonStyle(.plain).insetRowBackground()
                                .accessibilityAddTraits(chosen.contains(size.id) ? .isSelected : [])
                                .accessibilityIdentifier("browser.sizes.\(size.id)")
                            }
                        } header: { InsetHeader("Sizes") }
                    }
                    .insetGroupedList()
                    .transition(.opacity)
                }
            }
            .animation(AceTheme.Motion.standardCurve, value: asked)
            .animation(AceTheme.Motion.standardCurve, value: model.browser.sizes)
            .background(AceTheme.Colours.background)
            .navigationTitle("Screenshot at sizes").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose()
                if !asked || model.browser.sizes?.images?.isEmpty == true {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Take screenshots") {
                            asked = true
                            model.browserSizes(Self.sizes.map(\.id).filter { chosen.contains($0) })
                        }
                        .disabled(chosen.isEmpty)
                        .accessibilityIdentifier("browser.sizes.take")
                    }
                }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        .sensoryFeedback(.selection, trigger: chosen)
        .onAppear { model.browser.sizes = nil }
    }
    private func toggle(_ id: String) {
        if chosen.contains(id) { chosen.remove(id) } else { chosen.insert(id) }
    }
}

/// One size's screenshot, decoded off the main thread, with its size and Share.
private struct SizedShot: View {
    let image: BrowserSizes.Image
    @State private var picture: UIImage?
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            HStack {
                Text(image.size.capitalized).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                Text("\(image.width) × \(image.height)").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).monospacedDigit()
                Spacer()
                if let picture {
                    let shown = Image(uiImage: picture)
                    ShareLink(item: shown, preview: SharePreview("\(image.size.capitalized) screenshot", image: shown)) {
                        Text("Share")
                    }
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                }
            }
            ZStack {
                AceShape.block.fill(AceTheme.Colours.fill)
                if let picture {
                    Image(uiImage: picture).resizable().scaledToFit()
                        .clipShape(AceShape.block)
                        .transition(.opacity)
                }
            }
            .aspectRatio(CGFloat(max(image.width, 1)) / CGFloat(max(image.height, 1)), contentMode: .fit)
            .frame(maxWidth: .infinity)
            .animation(AceTheme.Motion.standardCurve, value: picture != nil)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("browser.sizes.shot.\(image.size)")
        .task(id: image.data.count) {
            let data = image.data
            picture = await Task.detached(priority: .userInitiated) {
                Data(base64Encoded: data).flatMap(UIImage.init(data:))?.preparingForDisplay()
            }.value
        }
    }
}

/// The extensions the browser runs, as its engine reports them, never a made-up list. ace's own
/// browser loads none; Use my Chrome lets agents work in the person's Chrome with its extensions.
/// The puzzle button can sit in the browser's top bar.
struct BrowserExtensionsSheet: View {
    @Bindable var model: ClientModel
    @AppStorage("ace.browser.extensionsInBar") private var inBar = false
    private var items: [BrowserExtensions.Item]? { model.browser.extensions?.items }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let items {
                        if items.isEmpty {
                            Text("No extensions installed").foregroundStyle(AceTheme.Colours.mutedForeground).insetRowBackground()
                        }
                        ForEach(items) { item in
                            InsetRow(icon: .puzzlePiece, title: item.name, subtitle: [item.version, item.enabled ? nil : "Off"].compactMap { $0 }.joined(separator: " · ")) { EmptyView() }
                                .insetRowBackground()
                        }
                    } else {
                        ForEach(0..<2, id: \.self) { _ in
                            Capsule().fill(AceTheme.Colours.fill).frame(width: 160, height: 12).frame(minHeight: InsetStyle.rowHeight, alignment: .leading)
                                .insetRowBackground()
                        }
                    }
                } header: { InsetHeader(items.map { "Extensions (\($0.count))" } ?? "Extensions") }
                Section {
                    InsetRow(systemImage: nil, title: "Show in the browser bar") {
                        Toggle("Show in the browser bar", isOn: $inBar).labelsHidden()
                    }
                    .insetRowBackground()
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("browser.extensions.inBar")
                    if model.browser.view?.state?.ownChrome != true {
                        NavigationLink { UseMyChromeView(model: model) } label: {
                            InsetRow("Use your Chrome's extensions", systemImage: nil)
                        }
                        .insetRowBackground()
                        .accessibilityIdentifier("browser.extensions.useMyChrome")
                    }
                }
            }
            .insetGroupedList()
            .animation(AceTheme.Motion.standardCurve, value: items)
            .navigationTitle("Extensions").navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetClose() }
        }
        .tint(AceTheme.Colours.foreground)
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        .sensoryFeedback(.selection, trigger: inBar)
        .onAppear { model.browserExtensions() }
        .onDisappear { model.browser.clearExtensions() }
    }
}
