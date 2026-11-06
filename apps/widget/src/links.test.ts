import { describe, expect, it } from "vitest";
import { isActionLink, isSiteLink, opensNewTab } from "./links.ts";

describe("widget link rules", () => {
  it("cites only https pages of the doctor's site", () => {
    expect(isSiteLink("https://drluisghilino.com.ar/#consultorios")).toBe(true);
    expect(isSiteLink("https://www.drluisghilino.com.ar/")).toBe(true);
    expect(isSiteLink("http://drluisghilino.com.ar/")).toBe(false);
    expect(isSiteLink("https://drluisghilino.com.ar.evil.example/")).toBe(false);
    expect(isSiteLink("javascript:alert(1)")).toBe(false);
    expect(isSiteLink("not a url")).toBe(false);
  });

  it("allows contact buttons for WhatsApp, Maps, phone and e-mail only", () => {
    expect(isActionLink("https://wa.me/5491140336567")).toBe(true);
    expect(isActionLink("https://www.google.com/maps/search/?api=1&query=Boulogne")).toBe(true);
    expect(isActionLink("tel:+5491140336567")).toBe(true);
    expect(isActionLink("mailto:doctorghilino@gmail.com")).toBe(true);
    expect(isActionLink("https://www.google.com/search?q=x")).toBe(false);
    expect(isActionLink("http://wa.me/5491140336567")).toBe(false);
    expect(isActionLink("tel:call-me")).toBe(false);
    expect(isActionLink("mailto:a@b.com?bcc=x@y.com")).toBe(false);
    expect(isActionLink("javascript:alert(1)")).toBe(false);
    expect(isActionLink("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("opens external links in a new tab and keeps site anchors in the page", () => {
    expect(opensNewTab("https://wa.me/5491140336567")).toBe(true);
    expect(opensNewTab("https://drluisghilino.com.ar/#contacto")).toBe(false);
    expect(opensNewTab("tel:+5491140336567")).toBe(false);
  });
});
