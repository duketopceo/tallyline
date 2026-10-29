import Foundation

/// Pairing codes arrive as `tlpair_…` or inside `tallyline://pair?c=…` (and
/// `s=` carries a suggested server URL for self-hosted instances).
public enum PairingCode {
    public static func normalize(_ input: String) -> String {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains("://"), let components = URLComponents(string: trimmed) else { return trimmed }
        if let code = components.queryItems?.first(where: { $0.name == "c" })?.value { return code }
        return trimmed
    }

    /// Server suggestion inside a pair URL, when present (`tallyline://pair?s=<url>&c=<code>`).
    public static func suggestedServer(_ input: String) -> URL? {
        guard let components = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              let s = components.queryItems?.first(where: { $0.name == "s" })?.value else { return nil }
        return URL(string: s)
    }
}
