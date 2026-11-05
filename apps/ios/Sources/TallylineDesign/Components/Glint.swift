#if os(iOS)
import SwiftUI

private struct GlintReducedKey: EnvironmentKey { static let defaultValue = false }
private struct PulseAnimatesKey: EnvironmentKey { static let defaultValue = true }

public extension EnvironmentValues {
    /// Draw the glint in grey for people who find the colour hard to read
    /// (Settings > Appearance).
    var glintReduced: Bool {
        get { self[GlintReducedKey.self] }
        set { self[GlintReducedKey.self] = newValue }
    }

    /// Whether the glint may pulse while an agent works.
    var pulseAnimates: Bool {
        get { self[PulseAnimatesKey.self] }
        set { self[PulseAnimatesKey.self] = newValue }
    }
}

/// Four-point star marking agent-authored or agent-held work. Pass
/// `pulsing` while an agent is actively working; it holds still under Reduce
/// Motion.
public struct Glint: View {
    /// Grows with Dynamic Type alongside the caption text it sits next to.
    @ScaledMetric(relativeTo: .caption) private var size: CGFloat = 12
    private let pulsing: Bool
    @State private var dim = false
    @Environment(\.accessibilityReduceMotion) private var systemReduces
    @Environment(\.appReducesMotion) private var appReduces
    @Environment(\.glintReduced) private var reduced
    @Environment(\.pulseAnimates) private var pulseAnimates

    public init(size: CGFloat = 12, pulsing: Bool = false) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: .caption)
        self.pulsing = pulsing
    }

    public var body: some View {
        GlintShape()
            .fill(reduced ? Theme.inkMuted : Theme.glint)
            .frame(width: size, height: size)
            .opacity(dim ? 0.45 : 1)
            .accessibilityLabel("Agent")
            .task(id: pulsing) {
                guard pulsing, pulseAnimates, let animation = Motion.animation(.ambient, reduceMotion: systemReduces || appReduces) else {
                    dim = false
                    return
                }
                withAnimation(animation) { dim = true }
            }
    }
}
#endif
