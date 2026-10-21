import { describe, expect, it } from "vitest";

import { RequestOriginPolicy } from "./request-origin-policy";

describe("RequestOriginPolicy", () => {
  it("allows requests without an Origin header (server-to-server proxy) and adds no CORS headers", () => {
    const policy = RequestOriginPolicy.fromAllowList(undefined);

    expect(policy.evaluate(null)).toStrictEqual({ allowed: true, corsHeaders: {} });
    expect(policy.evaluate("")).toStrictEqual({ allowed: true, corsHeaders: {} });
  });

  it("denies every browser origin when the allowlist is unset or empty", () => {
    expect(RequestOriginPolicy.fromAllowList(undefined).evaluate("https://shop.example.com")).toStrictEqual({
      allowed: false,
      origin: "https://shop.example.com",
    });
    expect(RequestOriginPolicy.fromAllowList("").evaluate("https://shop.example.com").allowed).toBe(false);
  });

  it("allows listed origins, normalizing case, whitespace and trailing slashes", () => {
    const policy = RequestOriginPolicy.fromAllowList(" https://Shop.Example.com/ ,https://other.example.com");

    expect(policy.evaluate("https://shop.example.com")).toStrictEqual({
      allowed: true,
      corsHeaders: { "Access-Control-Allow-Origin": "https://shop.example.com", Vary: "Origin" },
    });
    expect(policy.evaluate("https://other.example.com").allowed).toBe(true);
  });

  it("denies origins that only resemble a listed one", () => {
    const policy = RequestOriginPolicy.fromAllowList("https://shop.example.com");

    expect(policy.evaluate("http://shop.example.com").allowed).toBe(false);
    expect(policy.evaluate("https://shop.example.com:8443").allowed).toBe(false);
    expect(policy.evaluate("https://shop.example.com.evil.org").allowed).toBe(false);
    expect(policy.evaluate("null").allowed).toBe(false);
  });

  it("never treats '*' or malformed entries as allowing anything", () => {
    const policy = RequestOriginPolicy.fromAllowList("*,not a url,ftp://shop.example.com");

    expect(policy.evaluate("https://shop.example.com").allowed).toBe(false);
    expect(policy.evaluate("ftp://shop.example.com").allowed).toBe(false);
  });
});
