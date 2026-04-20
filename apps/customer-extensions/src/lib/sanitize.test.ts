import { describe, expect, it } from "vitest";

import {
  sanitizeEmail,
  sanitizeReviewComment,
  sanitizeText,
  sanitizeUserName,
} from "./sanitize";

describe("sanitize", () => {
  describe("sanitizeText", () => {
    it("should encode HTML special characters", () => {
      const input = '<script>alert("XSS")</script>';
      const result = sanitizeText(input);

      // HTML tags are stripped first, then quotes are encoded
      expect(result).not.toContain("<script>");
      expect(result).not.toContain("</script>");
      expect(result).toContain("&quot;"); // Quotes are encoded
      expect(result).toBe("alert(&quot;XSS&quot;)");
    });

    it("should strip HTML tags when stripHtml is true", () => {
      const input = "Hello <b>world</b>!";
      const result = sanitizeText(input, { stripHtml: true });

      // Tags are replaced with space (to maintain word boundaries), then normalized
      expect(result).toBe("Hello world !");
      expect(result).not.toContain("<b>");
      expect(result).not.toContain("</b>");
    });

    it("should encode special characters", () => {
      const input = 'Test "quotes" & <tags>';
      const result = sanitizeText(input);

      // Tags are stripped, special chars are encoded
      expect(result).toContain("&quot;");
      expect(result).toContain("&amp;");
      expect(result).not.toContain("<");
      expect(result).not.toContain(">");
      expect(result).toBe("Test &quot;quotes&quot; &amp;");
    });

    it("should remove control characters", () => {
      const input = "Hello\x00World\x1F!";
      const result = sanitizeText(input);

      // Control chars are replaced with space, then normalized
      expect(result).toBe("Hello World !");
      expect(result).not.toContain("\x00");
      expect(result).not.toContain("\x1F");
    });

    it("should normalize excessive whitespace", () => {
      const input = "Hello    world\n\n\n\nTest";
      const result = sanitizeText(input);

      expect(result).not.toContain("    ");
      expect(result).not.toContain("\n\n\n");
    });

    it("should enforce max length if specified", () => {
      const input = "a".repeat(100);
      const result = sanitizeText(input, { maxLength: 50 });

      expect(result).toHaveLength(50);
    });

    it("should remove newlines when allowNewlines is false", () => {
      const input = "Line 1\nLine 2\rLine 3";
      const result = sanitizeText(input, { allowNewlines: false });

      expect(result).not.toContain("\n");
      expect(result).not.toContain("\r");
      expect(result).toContain("Line 1 Line 2 Line 3");
    });
  });

  describe("sanitizeReviewComment", () => {
    it("should sanitize XSS attempts in review comments", () => {
      const xssAttempts = [
        '<script>alert("XSS")</script>',
        '<img src=x onerror=alert("XSS")>',
        '<iframe src="javascript:alert(\'XSS\')"></iframe>',
        'javascript:alert("XSS")',
        '<svg onload=alert("XSS")>',
      ];

      xssAttempts.forEach((xss) => {
        const result = sanitizeReviewComment(xss);

        expect(result).not.toContain("<script");
        expect(result).not.toContain("<img");
        expect(result).not.toContain("<iframe");
        expect(result).not.toContain("<svg");
        expect(result).not.toContain("onerror");
        expect(result).not.toContain("onload");
      });
    });

    it("should preserve legitimate review content", () => {
      const input = "This is a great product! I love it. 5/5 stars!";
      const result = sanitizeReviewComment(input);

      expect(result).toBe("This is a great product! I love it. 5&#x2F;5 stars!");
    });

    it("should handle unicode direction override attacks", () => {
      const input = "Review\u202Ekcatta";
      const result = sanitizeReviewComment(input);

      // Unicode direction override is removed (replaced with space, then normalized)
      expect(result).not.toContain("\u202E");
      expect(result).toBe("Review kcatta");
    });

    it("should enforce max length for review comments", () => {
      const input = "a".repeat(2000);
      const result = sanitizeReviewComment(input, 1000);

      expect(result.length).toBeLessThanOrEqual(1000);
    });

    it("should allow newlines in review comments", () => {
      const input = "Great product!\nHighly recommend.\nFive stars!";
      const result = sanitizeReviewComment(input);

      // Newlines should be preserved (though normalized)
      expect(result).toContain("Great product!");
      expect(result).toContain("Highly recommend.");
    });
  });

  describe("sanitizeUserName", () => {
    it("should sanitize XSS attempts in user names", () => {
      const input = '<script>alert("XSS")</script>';
      const result = sanitizeUserName(input);

      // Tags are stripped, quotes are encoded
      expect(result).not.toContain("<script>");
      expect(result).not.toContain("<");
      expect(result).not.toContain(">");
      expect(result).toBe("alert(&quot;XSS&quot;)");
    });

    it("should not allow newlines in user names", () => {
      const input = "John\nDoe";
      const result = sanitizeUserName(input);

      expect(result).not.toContain("\n");
      expect(result).toBe("John Doe");
    });

    it("should enforce max length for user names", () => {
      const input = "a".repeat(200);
      const result = sanitizeUserName(input, 100);

      expect(result.length).toBeLessThanOrEqual(100);
    });

    it("should preserve normal user names", () => {
      const input = "John Doe";
      const result = sanitizeUserName(input);

      expect(result).toBe("John Doe");
    });
  });

  describe("sanitizeEmail", () => {
    it("should remove HTML from email addresses", () => {
      const input = '<script>alert("XSS")</script>test@example.com';
      const result = sanitizeEmail(input);

      expect(result).not.toContain("<script>");
      expect(result).toContain("test@example.com");
    });

    it("should normalize email to lowercase", () => {
      const input = "Test@Example.COM";
      const result = sanitizeEmail(input);

      expect(result).toBe("test@example.com");
    });

    it("should remove control characters from email", () => {
      const input = "test\x00@example.com";
      const result = sanitizeEmail(input);

      // Control characters are replaced with space, then whitespace is normalized
      expect(result).not.toContain("\x00");
      // Note: whitespace is preserved in email sanitization (trimmed but not normalized like in text)
      expect(result).toBe("test @example.com");
    });

    it("should trim whitespace from email", () => {
      const input = "  test@example.com  ";
      const result = sanitizeEmail(input);

      expect(result).toBe("test@example.com");
    });
  });

  describe("XSS attack vectors", () => {
    it("should protect against common XSS payloads", () => {
      const xssPayloads = [
        // Script injection
        '<script>alert(document.cookie)</script>',
        // Event handler injection
        '<img src=x onerror=alert(1)>',
        // SVG-based XSS
        '<svg><script>alert(1)</script></svg>',
        // Data URI XSS
        '<a href="data:text/html,<script>alert(1)</script>">Click</a>',
        // JavaScript protocol
        '<a href="javascript:alert(1)">Click</a>',
        // HTML entities bypass
        '&#60;script&#62;alert(1)&#60;/script&#62;',
        // Nested tags
        '<<SCRIPT>alert(1)//<<SCRIPT>',
      ];

      xssPayloads.forEach((payload) => {
        const result = sanitizeReviewComment(payload);

        // Should not contain executable script tags
        expect(result.toLowerCase()).not.toContain("<script");
        // Should not contain event handlers
        expect(result.toLowerCase()).not.toContain("onerror");
        expect(result.toLowerCase()).not.toContain("onload");
        // Should not contain dangerous protocols
        expect(result.toLowerCase()).not.toContain("javascript:");
      });
    });

    it("should protect against angle bracket variations", () => {
      const variations = [
        "<script>alert(1)</script>",
        "＜script＞alert(1)＜/script＞", // Full-width characters
        "<scr<script>ipt>alert(1)</scr</script>ipt>",
      ];

      variations.forEach((variant) => {
        const result = sanitizeReviewComment(variant);

        // Should not execute as script
        expect(result).not.toContain("<script");
      });
    });
  });
});
