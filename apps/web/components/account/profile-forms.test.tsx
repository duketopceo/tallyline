import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PasswordForm, ProfileForm } from "./profile-forms";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

describe("ProfileForm", () => {
  it("labels every field and prefills the current values", () => {
    const html = renderToStaticMarkup(<ProfileForm name="Ada Lovelace" avatarUrl="https://img.example.test/a.png" />);
    expect(html).toContain('for="profile-name"');
    expect(html).toContain('for="profile-avatar"');
    expect(html).toContain('value="Ada Lovelace"');
    expect(html).toContain('value="https://img.example.test/a.png"');
    expect(html).toContain("Save profile");
  });

  it("starts the picture field empty when there is none", () => {
    const html = renderToStaticMarkup(<ProfileForm name="Ada" avatarUrl={null} />);
    expect(html).toContain('value=""');
  });
});

describe("PasswordForm", () => {
  it("asks for the current password and a confirmed new one, with autocomplete hints", () => {
    const html = renderToStaticMarkup(<PasswordForm hasPassword />);
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).toMatch(/autocomplete="new-password"/i);
    expect(html).toContain("Confirm new password");
    expect(html).toContain("Change password");
  });

  it("offers the reset link instead of a form when the account has no password, and underlines it", () => {
    const html = renderToStaticMarkup(<PasswordForm hasPassword={false} />);
    expect(html).not.toContain("<form");
    expect(html).toContain('href="/forgot-password"');
    // a link inside a sentence must not rely on colour alone
    expect(html).toMatch(/class="[^"]*\bunderline\b[^"]*"/);
  });
});
