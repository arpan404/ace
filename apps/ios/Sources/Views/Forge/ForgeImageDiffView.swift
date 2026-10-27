import SwiftUI

/// A changed image, its two versions read through the daemon: the one side there is, or both,
/// side by side or stacked with a swipe that reveals the new version over the old. The slider
/// is the control; dragging across the image moves it too. Bytes decode off the main thread.
struct ForgeImageDiffView: View {
    let client: ClientModel
    let route: ForgeRoute
    /// The commits to draw; a new pair (a push, a refresh) reads again.
    let revisions: ForgeFileRevisions?
    /// Tells the page which commits are on screen, so Viewed names that version.
    let shown: (ForgeFileRevisions?) -> Void
    @State private var sides: Sides?
    @State private var failure: String?
    @State private var layout = Layout.side
    @State private var reveal = 0.5
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    enum Layout: String, CaseIterable { case side = "Side by side", swipe = "Swipe" }
    struct Side: Sendable { let image: UIImage?; let size: Int?; let note: String? }
    struct Sides: Sendable { let before: Side; let after: Side }

    var body: some View {
        VStack(spacing: AceTheme.Spacing.md) {
            if let sides {
                content(sides).transition(.opacity)
            } else if let failure {
                EmptyState(icon: nil, title: "Couldn't load the images", line: failure, failed: true) {
                    Button("Try again") { Task { await load() } }
                }
            } else {
                AceTheme.Colours.fill.aspectRatio(16 / 9, contentMode: .fit)
                    .clipShape(AceShape.rounded(AceTheme.Radii.sm))
                    .overlay(ProgressView())
            }
        }
        .padding(AceTheme.Spacing.lg)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth, value: sides == nil)
        .task(id: ForgeSidesKey(route: route, revisions: revisions)) { await load() }
    }

    @ViewBuilder private func content(_ sides: Sides) -> some View {
        if let before = sides.before.image, let after = sides.after.image {
            Picker("Image comparison", selection: $layout) {
                ForEach(Layout.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("forge.image.layout")
            .sensoryFeedback(.selection, trigger: layout)
            Group {
                if layout == .side {
                    HStack(alignment: .top, spacing: AceTheme.Spacing.md) {
                        figure(before, label: "Before", size: sides.before.size)
                        figure(after, label: "After", size: sides.after.size)
                    }
                } else {
                    swipe(before, after, sides)
                }
            }
            .transition(.opacity)
            .animation(AceMotion.smooth, value: layout)
        } else {
            let added = sides.after.image != nil
            if let only = sides.after.image ?? sides.before.image {
                figure(only, label: added ? "Added" : "Removed", size: added ? sides.after.size : sides.before.size)
            }
            ForEach([sides.before.note, sides.after.note].compactMap { $0 }, id: \.self) { Text($0).meta() }
        }
    }

    private func figure(_ image: UIImage, label: String, size: Int?) -> some View {
        VStack(spacing: AceTheme.Spacing.xs) {
            Image(uiImage: image).resizable().aspectRatio(contentMode: .fit)
                .clipShape(AceShape.rounded(AceTheme.Radii.sm))
                .overlay(AceShape.rounded(AceTheme.Radii.sm).strokeBorder(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
                .accessibilityLabel("\(route.path ?? "Image") \(label.lowercased())")
            Text(size.map { "\(label) · \(ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file))" } ?? label)
                .meta().monospacedDigit()
        }
        .frame(maxWidth: .infinity)
    }

    private func swipe(_ before: UIImage, _ after: UIImage, _ sides: Sides) -> some View {
        VStack(spacing: AceTheme.Spacing.sm) {
            GeometryReader { box in
                ZStack(alignment: .leading) {
                    Image(uiImage: before).resizable().aspectRatio(contentMode: .fit)
                    Image(uiImage: after).resizable().aspectRatio(contentMode: .fit)
                        .mask(alignment: .trailing) {
                            Rectangle().frame(width: box.size.width * (1 - reveal))
                        }
                    Rectangle().fill(AceTheme.Colours.accent)
                        .frame(width: 2)
                        .offset(x: box.size.width * reveal - 1)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
                // Dragging across the image moves the slider: an accelerator for it.
                .gesture(DragGesture(minimumDistance: 0).onChanged { drag in
                    reveal = min(1, max(0, drag.location.x / max(1, box.size.width)))
                })
            }
            .aspectRatio(after.size.width / max(1, after.size.height), contentMode: .fit)
            .clipShape(AceShape.rounded(AceTheme.Radii.sm))
            Slider(value: $reveal, in: 0...1) { Text("Swipe between before and after") }
                .accessibilityValue("\(Int(reveal * 100)) percent before")
                .accessibilityIdentifier("forge.image.swipe")
            HStack {
                Text("Before"); Spacer(); Text("After")
            }
            .meta()
        }
    }

    private func load() async {
        do {
            let read = try await client.forgeFileSides(route, as: "image", revisions: revisions)
            guard case .image(let before, let after) = read.sides else { return }
            // Base64 and image decoding stay off the main thread; a long image never stalls a scroll.
            let decoded = await Task.detached(priority: .userInitiated) {
                Sides(before: Self.side(before), after: Self.side(after))
            }.value
            sides = decoded
            failure = nil
            shown(read.revisions)
        } catch is CancellationError {
        } catch { failure = error.localizedDescription }
    }

    nonisolated private static func side(_ side: ForgeFileSides.Image) -> Side {
        guard side.state == "image", let data = side.data.flatMap({ Data(base64Encoded: $0) }) else {
            return Side(image: nil, size: side.size, note: side.state == "unavailable" ? side.reason : nil)
        }
        let image = UIImage(data: data)?.preparingForDisplay()
        return Side(image: image, size: side.size, note: image == nil ? "Can't be shown here" : nil)
    }
}

/// What a file's sides are read for: the file, and the exact commits.
struct ForgeSidesKey: Hashable {
    let route: ForgeRoute
    let revisions: ForgeFileRevisions?
}
