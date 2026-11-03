import Foundation

/// Pairing codes arrive as `tlpair_…` or inside a `tallyline://pair` URL. The
/// API mints that URL as `?server=…&code=…`; hand-written links have carried
/// `?s=…&c=…`, so both spellings are read.
public enum PairingCode {
    public static func normalize(_ input: String) -> String {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains("://"), let components = URLComponents(string: trimmed) else { return trimmed }
        if let code = query(components, ["c", "code"]) { return code }
        return trimmed
    }

    /// Server suggestion inside a pair URL, when present.
    public static func suggestedServer(_ input: String) -> URL? {
        guard let components = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              let s = query(components, ["s", "server"]) else { return nil }
        return URL(string: s)
    }

    /// First non-empty value among `names`, in order.
    private static func query(_ components: URLComponents, _ names: [String]) -> String? {
        let items = components.queryItems ?? []
        for name in names {
            if let v = items.first(where: { $0.name == name })?.value, !v.isEmpty { return v }
        }
        return nil
    }
}
