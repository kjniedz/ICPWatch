import { describe, expect, it } from "vitest";
import { classifyUrl, normalizeUrl } from "../src/meta";

describe("normalizeUrl", () => {
  it("forces https, lowercases the host, strips tracking and trailing slash", () => {
    expect(normalizeUrl("HTTP://Example.com/?utm_source=x")).toBe("https://example.com");
    expect(normalizeUrl("oc.app/")).toBe("https://oc.app");
    expect(normalizeUrl("https://x.com/OpenChat#top")).toBe("https://x.com/OpenChat");
  });
  it("rejects things that are not web addresses", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
    expect(normalizeUrl("localhost")).toBeNull();
  });
});

describe("classifyUrl", () => {
  it("maps hosts to link kinds", () => {
    expect(classifyUrl("https://x.com/OpenChat")).toBe("twitter");
    expect(classifyUrl("https://t.me/openchat")).toBe("telegram");
    expect(classifyUrl("https://github.com/open-chat-labs")).toBe("github");
    expect(classifyUrl("https://docs.oc.app/intro")).toBe("docs");
    expect(classifyUrl("https://forum.dfinity.org/t/x/1")).toBe("forum");
    expect(classifyUrl("https://example.com/whitepaper.pdf")).toBe("whitepaper");
    expect(classifyUrl("https://oc.app")).toBe("website");
  });
});
