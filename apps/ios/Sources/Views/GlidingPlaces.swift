import SwiftUI

/// The places inside a bar's glass capsule, the phone's tab bar (`HomeBar`) and the iPad sidebar's
/// foot (`SidebarPlaces`), moving the chosen fill as the system's tab bar does. A finger pressed on
/// the bar draws the fill under it, swollen a little, and the fill follows the finger along the
/// bar; each place it passes lights up with a selection tap. Lifted, the fill springs onto the
/// place under it and that place opens. A tap is the same press and release, so it springs too, and
/// a new press catches the fill wherever it is. Under Reduce Motion the fill never travels: it
/// fades from one place to the next.
///
/// The finger stays in this view's own gesture state, so a slide redraws only the bar and never
/// writes the model; the place is chosen once, on release. Every place is the same width.
struct GlidingPlaces<Place: View>: View {
    let places: [InboxTab]
    let chosen: InboxTab
    let spacing: CGFloat
    /// A place's look; `lit` while it shows or the finger is over it. It carries its own
    /// accessibility element, label and identifier; this adds the button traits and the action.
    let place: (InboxTab, _ lit: Bool) -> Place
    /// A place picked by a release over it, a tap or VoiceOver.
    let select: (InboxTab) -> Void

    /// The finger's position along the row; nil while none is down. Gesture state resets itself
    /// when the system takes the touch away mid-slide.
    @GestureState(resetTransaction: Transaction(animation: AceDesign.Motion.tabSettle))
    private var finger: CGFloat?
    @State private var width: CGFloat = 0
    @Environment(\.aceReduceMotion) private var reduceMotion

    init(places: [InboxTab], chosen: InboxTab, spacing: CGFloat,
         @ViewBuilder place: @escaping (InboxTab, _ lit: Bool) -> Place,
         select: @escaping (InboxTab) -> Void) {
        self.places = places
        self.chosen = chosen
        self.spacing = spacing
        self.place = place
        self.select = select
    }

    private static var inset: CGFloat { AceDesign.Size.tabInset }

    var body: some View {
        let glide = TabGlide(count: places.count, width: width, spacing: spacing)
        let chosenIndex = places.firstIndex(of: chosen) ?? 0
        let lit = finger.map(glide.index(at:)) ?? chosenIndex
        HStack(spacing: spacing) {
            ForEach(Array(places.enumerated()), id: \.element) { index, item in
                place(item, index == lit)
                    .accessibilityAddTraits(item == chosen ? [.isSelected, .isButton] : .isButton)
                    .accessibilityAction { select(item) }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .background(alignment: .leading) { fill(glide, lit: lit, chosen: chosenIndex) }
        .padding(Self.inset)
        .contentShape(AceShape.capsule)
        .gesture(slide(glide, chosen: chosenIndex))
        // A selection tap for each place the finger passes, and for a tap's press; none for a
        // place chosen elsewhere.
        .sensoryFeedback(AceDesign.Haptic.tab, trigger: lit) { _, _ in finger != nil }
    }

    @ViewBuilder private func fill(_ glide: TabGlide, lit: Int, chosen: Int) -> some View {
        if reduceMotion {
            ZStack(alignment: .leading) {
                ForEach(places.indices, id: \.self) { index in
                    pill(glide).offset(x: glide.offset(of: index)).opacity(index == lit ? 1 : 0)
                }
            }
            .animation(.default, value: lit)
        } else {
            pill(glide)
                .scaleEffect(finger == nil ? 1 : AceDesign.Motion.tabLift)
                .offset(x: finger.map(glide.offset(following:)) ?? glide.offset(of: chosen))
                // A place chosen elsewhere (the other bar, a link) glides there too.
                .animation(AceDesign.Motion.tabSettle, value: chosen)
        }
    }

    private func pill(_ glide: TabGlide) -> some View {
        AceShape.capsule.fill(AceDesign.Surface.fill).frame(width: glide.slot)
    }

    private func slide(_ glide: TabGlide, chosen: Int) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .updating($finger) { value, finger, transaction in
                transaction.animation = AceDesign.Motion.tabFollow
                finger = value.location.x - Self.inset
            }
            .onEnded { value in
                let start = value.startLocation.x - Self.inset
                guard let picked = glide.release(from: start, at: value.location.x - Self.inset, chosen: chosen),
                      places.indices.contains(picked) else { return }
                withAnimation(reduceMotion ? .default : AceDesign.Motion.tabSettle) { select(places[picked]) }
            }
    }
}
