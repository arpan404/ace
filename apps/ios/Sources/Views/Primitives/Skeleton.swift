import SwiftUI

/// Loading, everywhere the same (DESIGN.md §3 "Loading"): still pills in the shape of what is
/// coming, never a page spinner, never moving. Rows are three lines (a meta line, the title, a
/// meta line); a page is a title and a few lines of text. On the page gutter.
///
/// A placeholder never stands in for long: past `SkeletonPatience.wait` without what it stands for,
/// it says in words that the computer hasn't answered, with Retry where the page can ask again.
struct SkeletonRows: View {
    // Bar widths and heights trace the lines they stand in for (meta, title, meta): content geometry.
    var count = 5
    var label = "Loading"
    /// Asks again; nil where the page fills in on its own when the answer comes.
    var retry: (() -> Void)? = nil
    var body: some View {
        SkeletonPatience(retry: retry) {
            VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                ForEach(0..<count, id: \.self) { index in
                    VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                        SkeletonBar(width: 104, height: 11)
                        SkeletonBar(width: index.isMultiple(of: 2) ? 236 : 188, height: 15)
                        SkeletonBar(width: 136, height: 11)
                    }
                }
            }
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.vertical, AceDesign.Space.row)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
        }
    }
}

/// A page while it reads: a heading and a few lines of prose.
struct SkeletonPage: View {
    // A heading's bar, then body lines: the text's own measure.
    var label = "Loading"
    var retry: (() -> Void)? = nil
    var body: some View {
        SkeletonPatience(retry: retry) {
            VStack(alignment: .leading, spacing: AceDesign.Space.row) {
                SkeletonBar(width: 220, height: 20)
                ForEach(0..<5, id: \.self) { index in
                    SkeletonBar(width: index == 4 ? 180 : nil, height: 13)
                }
            }
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.vertical, AceDesign.Space.margin)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// One still pill; `nil` width fills the line.
struct SkeletonBar: View {
    var width: CGFloat?
    let height: CGFloat
    var body: some View {
        AceDesign.Shape.control.fill(AceDesign.Surface.fill)
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }
}

/// Shows its placeholder while an answer is due, then, if none has come, the sentence that says
/// so. The placeholder's owner removes it when the answer arrives, which ends the wait.
struct SkeletonPatience<Placeholder: View>: View {
    /// How long a placeholder may stand before it says the computer hasn't answered.
    static var wait: Duration { .seconds(10) }
    var retry: (() -> Void)?
    @ViewBuilder var placeholder: () -> Placeholder
    @State private var stalled = false
    @State private var attempt = 0

    var body: some View {
        Group {
            if stalled {
                SkeletonStalled(retry: retry.map { retry in { stalled = false; attempt += 1; retry() } })
                    .transition(.opacity)
            } else {
                placeholder()
            }
        }
        .task(id: attempt) {
            try? await Task.sleep(for: Self.wait)
            if !Task.isCancelled { withAnimation { stalled = true } }
        }
    }
}

/// The words a placeholder gives way to: what is happening, and Retry where the page can ask again.
struct SkeletonStalled: View {
    var retry: (() -> Void)?
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text("Still waiting for your computer")
                .aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                .foregroundStyle(AceDesign.Ink.primary)
            Text(retry == nil ? "It may be busy or offline. This fills in when it answers." : "It may be busy or offline.")
                .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                .foregroundStyle(AceDesign.Ink.muted)
                .fixedSize(horizontal: false, vertical: true)
            if let retry {
                Button("Retry", action: retry)
                    .buttonStyle(.textAction(.prominent))
                    .accessibilityIdentifier("skeleton.retry")
            }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.vertical, AceDesign.Space.row)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("skeleton.stalled")
    }
}
