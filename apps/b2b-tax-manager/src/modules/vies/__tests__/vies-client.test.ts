import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkVat, _internal } from "../vies-client";

const { buildSoapEnvelope, parseSoapResponse, extractTag } = _internal;

describe("ViesClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("buildSoapEnvelope", () => {
    it("builds valid SOAP XML with country code and VAT number", () => {
      const xml = buildSoapEnvelope("DE", "123456789");
      expect(xml).toContain("<urn:countryCode>DE</urn:countryCode>");
      expect(xml).toContain("<urn:vatNumber>123456789</urn:vatNumber>");
    });
  });

  describe("extractTag", () => {
    it("extracts simple tag value", () => {
      expect(extractTag("<valid>true</valid>", "valid")).toBe("true");
    });

    it("extracts namespaced tag", () => {
      expect(extractTag("<ns2:valid>false</ns2:valid>", "valid")).toBe("false");
    });

    it("returns empty string for missing tag", () => {
      expect(extractTag("<other>test</other>", "valid")).toBe("");
    });
  });

  describe("parseSoapResponse", () => {
    it("parses valid VIES response", () => {
      const xml = `
        <soap:Envelope>
          <soap:Body>
            <checkVatResponse>
              <countryCode>DE</countryCode>
              <vatNumber>123456789</vatNumber>
              <requestDate>2026-03-17</requestDate>
              <valid>true</valid>
              <name>Test GmbH</name>
              <address>Berlin, Germany</address>
            </checkVatResponse>
          </soap:Body>
        </soap:Envelope>`;

      const result = parseSoapResponse(xml);
      expect(result.isOk()).toBe(true);

      const value = result._unsafeUnwrap();
      expect(value.valid).toBe(true);
      expect(value.name).toBe("Test GmbH");
      expect(value.address).toBe("Berlin, Germany");
      expect(value.countryCode).toBe("DE");
    });

    it("parses invalid VAT response", () => {
      const xml = `
        <soap:Envelope>
          <soap:Body>
            <checkVatResponse>
              <countryCode>DE</countryCode>
              <vatNumber>000000000</vatNumber>
              <requestDate>2026-03-17</requestDate>
              <valid>false</valid>
              <name>---</name>
              <address>---</address>
            </checkVatResponse>
          </soap:Body>
        </soap:Envelope>`;

      const result = parseSoapResponse(xml);
      expect(result.isOk()).toBe(true);

      const value = result._unsafeUnwrap();
      expect(value.valid).toBe(false);
      expect(value.name).toBe("");
      expect(value.address).toBe("");
    });

    it("handles SOAP fault", () => {
      const xml = `
        <soap:Envelope>
          <soap:Body>
            <soap:Fault>
              <faultcode>soap:Server</faultcode>
              <faultstring>MS_UNAVAILABLE</faultstring>
            </soap:Fault>
          </soap:Body>
        </soap:Envelope>`;

      const result = parseSoapResponse(xml);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBe("SOAP_FAULT");
    });
  });

  describe("checkVat", () => {
    it("strips country prefix from VAT number", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(`
          <soap:Envelope><soap:Body>
            <checkVatResponse>
              <countryCode>DE</countryCode>
              <vatNumber>123456789</vatNumber>
              <requestDate>2026-03-17</requestDate>
              <valid>true</valid>
              <name>Test</name>
              <address>Berlin</address>
            </checkVatResponse>
          </soap:Body></soap:Envelope>
        `),
      );

      await checkVat("DE", "DE123456789");

      const body = fetchSpy.mock.calls[0][1]?.body as string;
      expect(body).toContain("<urn:vatNumber>123456789</urn:vatNumber>");
    });

    it("maps GR country code to EL for VIES", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(`
          <soap:Envelope><soap:Body>
            <checkVatResponse>
              <countryCode>EL</countryCode>
              <vatNumber>123456789</vatNumber>
              <requestDate>2026-03-17</requestDate>
              <valid>true</valid>
              <name>Test</name>
              <address>Athens</address>
            </checkVatResponse>
          </soap:Body></soap:Envelope>
        `),
      );

      await checkVat("GR", "EL123456789");

      const body = fetchSpy.mock.calls[0][1]?.body as string;
      expect(body).toContain("<urn:countryCode>EL</urn:countryCode>");
    });

    it("returns VIES_UNAVAILABLE on HTTP error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Server Error", { status: 500 }),
      );

      const result = await checkVat("DE", "123456789");
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBe("VIES_UNAVAILABLE");
    });

    it("returns VIES_TIMEOUT on abort", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        return new Promise((_, reject) => {
          const error = new DOMException(
            "The operation was aborted",
            "AbortError",
          );
          setTimeout(() => reject(error), 10);
        });
      });

      const result = await checkVat("DE", "123456789");
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBe("VIES_TIMEOUT");
    });

    it("returns VIES_UNAVAILABLE on network error", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("Network failure"),
      );

      const result = await checkVat("DE", "123456789");
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBe("VIES_UNAVAILABLE");
    });
  });
});
