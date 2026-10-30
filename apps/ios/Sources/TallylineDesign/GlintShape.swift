#if os(iOS)
import SwiftUI

/// The glint glyph from DESIGN.md: a four-point star on a 16-unit box with a
/// narrow waist on the diagonals. Scales to any frame.
public struct GlintShape: Shape {
    public init() {}

    public func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 16
        let ox = rect.midX - 8 * s
        let oy = rect.midY - 8 * s
        let points: [(CGFloat, CGFloat)] = [
            (8, 0), (9.8, 6.2), (16, 8), (9.8, 9.8),
            (8, 16), (6.2, 9.8), (0, 8), (6.2, 6.2),
        ]
        var path = Path()
        for (i, p) in points.enumerated() {
            let pt = CGPoint(x: ox + p.0 * s, y: oy + p.1 * s)
            if i == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
        }
        path.closeSubpath()
        return path
    }
}
#endif
