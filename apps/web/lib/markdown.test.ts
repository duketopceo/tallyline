import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

// Status updates render through this component (U14): it must never turn
// markup or a script URL into live HTML.
const render = (source: string) => renderToStaticMarkup(createElement(Markdown, { source }));

describe("Markdown safety", () => {
  it("does not link javascript: URLs", () => {
    expect(render("[x](javascript:alert(1))")).not.toContain("<a ");
  });
  it("escapes raw HTML in the body", () => {
    expect(render("<img src=x onerror=alert(1)>")).not.toContain("<img");
  });
  it("links https URLs with noopener", () => {
    expect(render("[ok](https://example.com)")).toContain('rel="noopener noreferrer"');
  });
});
