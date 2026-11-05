import Foundation

/// One or two capital letters for the profile button: "Ada Lovelace" is "AL",
/// "ada" is "A", nothing at all is "?".
public enum Initials {
    public static func from(_ name: String?) -> String {
        let words = (name ?? "")
            .split(whereSeparator: { $0.isWhitespace || $0 == "." || $0 == "@" })
            .filter { $0.first?.isLetter == true }
        guard let first = words.first?.first else { return "?" }
        if words.count > 1, let last = words.last?.first {
            return String(first).uppercased() + String(last).uppercased()
        }
        return String(first).uppercased()
    }
}
