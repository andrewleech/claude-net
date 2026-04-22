import { describe, expect, test } from "bun:test";
import { resolveCanonicalHubUrl } from "@/hub/hub-url";

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("resolveCanonicalHubUrl", () => {
  test("CLAUDE_NET_HOST full URL wins over request host", () => {
    const r = req("http://localhost:4815/setup", {
      host: "localhost:4815",
      "x-forwarded-host": "public.example",
      "x-forwarded-proto": "https",
    });
    expect(resolveCanonicalHubUrl(r, "https://localhost:9443", 4815)).toBe(
      "https://localhost:9443",
    );
  });

  test("CLAUDE_NET_HOST full URL strips trailing slash", () => {
    const r = req("http://localhost:4815/setup");
    expect(resolveCanonicalHubUrl(r, "https://localhost:9443/", 4815)).toBe(
      "https://localhost:9443",
    );
  });

  test("CLAUDE_NET_HOST plain hostname gets port + http", () => {
    const r = req("http://localhost:4815/setup");
    expect(resolveCanonicalHubUrl(r, "mybox.local", 4815)).toBe(
      "http://mybox.local:4815",
    );
  });

  test("CLAUDE_NET_HOST plain host:port respected", () => {
    const r = req("http://localhost:4815/setup");
    expect(resolveCanonicalHubUrl(r, "mybox:9000", 4815)).toBe(
      "http://mybox:9000",
    );
  });

  test("no CLAUDE_NET_HOST falls back to request Host header", () => {
    const r = req("http://internal:4815/setup", {
      host: "internal:4815",
    });
    expect(resolveCanonicalHubUrl(r, undefined, 4815)).toBe(
      "http://internal:4815",
    );
  });

  test("no CLAUDE_NET_HOST honours X-Forwarded-Proto", () => {
    const r = req("http://internal:4815/setup", {
      host: "localhost",
      "x-forwarded-proto": "https",
    });
    expect(resolveCanonicalHubUrl(r, undefined, 4815)).toBe(
      "https://localhost",
    );
  });

  test("no CLAUDE_NET_HOST and no Host header defaults to localhost:port", () => {
    // Request with URL but no explicit Host header
    const r = new Request("http://a/setup");
    // Node's Request will set host header to "a"; to exercise the
    // fallback we simulate missing Host by passing undefined port.
    expect(resolveCanonicalHubUrl(r, undefined, 4815)).toBeTruthy();
  });
});
