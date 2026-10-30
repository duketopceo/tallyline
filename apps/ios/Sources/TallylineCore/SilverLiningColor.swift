import Foundation

/// A parsed Silver Lining colour: sRGB components in 0...1.
public struct SilverLiningRGBA: Sendable, Equatable {
    public let red: Double
    public let green: Double
    public let blue: Double
    public let alpha: Double

    public init(red: Double, green: Double, blue: Double, alpha: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    /// Parses the token formats the generator emits: `#rgb`, `#rrggbb`,
    /// `#rrggbbaa` and `rgba(r,g,b,a)` / `rgb(r,g,b)` with 0...255 channels.
    public static func parse(_ value: String) -> SilverLiningRGBA? {
        let s = value.trimmingCharacters(in: .whitespaces).lowercased()
        if s.hasPrefix("#") { return parseHex(String(s.dropFirst())) }
        if s.hasPrefix("rgba(") || s.hasPrefix("rgb(") { return parseFunction(s) }
        return nil
    }

    private static func parseHex(_ hex: String) -> SilverLiningRGBA? {
        var digits = hex
        if digits.count == 3 { digits = digits.map { "\($0)\($0)" }.joined() }
        guard digits.count == 6 || digits.count == 8, let raw = UInt64(digits, radix: 16) else { return nil }
        let hasAlpha = digits.count == 8
        let value = hasAlpha ? raw : (raw << 8) | 0xFF
        return SilverLiningRGBA(
            red: Double((value >> 24) & 0xFF) / 255,
            green: Double((value >> 16) & 0xFF) / 255,
            blue: Double((value >> 8) & 0xFF) / 255,
            alpha: Double(value & 0xFF) / 255
        )
    }

    private static func parseFunction(_ s: String) -> SilverLiningRGBA? {
        guard let open = s.firstIndex(of: "("), let close = s.lastIndex(of: ")"), open < close else { return nil }
        let parts = s[s.index(after: open)..<close]
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 3 || parts.count == 4 else { return nil }
        let channels = parts.prefix(3).compactMap { Double($0) }
        guard channels.count == 3, channels.allSatisfy({ (0...255).contains($0) }) else { return nil }
        let alpha = parts.count == 4 ? Double(parts[3]) : 1
        guard let alpha, (0...1).contains(alpha) else { return nil }
        return SilverLiningRGBA(red: channels[0] / 255, green: channels[1] / 255, blue: channels[2] / 255, alpha: alpha)
    }
}

/// Which shipped palette applies for a given appearance.
public enum SilverLiningAppearance: String, Sendable, CaseIterable {
    case system, light, dark

    /// Palette for the resolved interface style. High contrast swaps the dark
    /// palette for `hc-dark`; light has no separate high-contrast palette yet.
    public static func palette(isDark: Bool, highContrast: Bool) -> SilverLiningPalette {
        if !isDark { return SilverLiningTokens.light }
        return highContrast ? SilverLiningTokens.hcDark : SilverLiningTokens.dark
    }
}
