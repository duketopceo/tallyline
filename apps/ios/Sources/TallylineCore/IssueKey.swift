import Foundation

/// Issue keys as people type or say them: "eng 12", "ENG-12", "eng12".
public enum IssueKey {
    /// `TEAM-123` in canonical form, or nil when the text is not a key.
    /// With a separator the team part may hold digits (`A1-7`); without one
    /// the team is the leading letters (`eng12` is `ENG-12`).
    public static func normalize(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let parts = t.split(whereSeparator: { $0 == "-" || $0 == " " || $0 == "_" })
        let team: Substring
        let number: Substring
        if parts.count == 2 {
            team = parts[0]
            number = parts[1]
        } else if parts.count == 1 {
            let word = parts[0]
            guard let firstDigit = word.firstIndex(where: \.isNumber) else { return nil }
            team = word[..<firstDigit]
            number = word[firstDigit...]
        } else {
            return nil
        }
        guard let head = team.first, head.isASCII, head.isLetter, team.count <= 10,
              team.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }),
              (1...9).contains(number.count), number.allSatisfy({ $0.isASCII && $0.isNumber }),
              number.first != "0"
        else { return nil }
        return "\(team)-\(number)"
    }
}

/// Remembers the team a new issue goes to, for places with no team picker
/// (Shortcuts, the share sheet).
public struct TeamMemory {
    public static let key = "lastTeamId"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var teamId: String? {
        get { defaults.string(forKey: Self.key) }
        nonmutating set { defaults.set(newValue, forKey: Self.key) }
    }

    /// The remembered team if it still exists, else the first team.
    public func pick(from teams: [Team]) -> Team? {
        teams.first { $0.id == teamId } ?? teams.first
    }
}
