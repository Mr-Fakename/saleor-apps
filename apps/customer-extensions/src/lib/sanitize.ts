/**
 * Security utilities for sanitizing user input to prevent XSS attacks
 */

/**
 * Encodes HTML special characters to prevent XSS
 * Converts: < > & " ' to their HTML entity equivalents
 */
function encodeHtmlEntities(str: string): string {
  const entityMap: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
    "/": "&#x2F;",
  };

  return str.replace(/[&<>"'/]/g, (char) => entityMap[char] || char);
}

/**
 * Strips HTML tags from user input
 * Removes anything between < and >, replacing with space to maintain word boundaries
 */
function stripHtmlTags(str: string): string {
  return str.replace(/<[^>]*>/g, " ");
}

/**
 * Removes potentially dangerous Unicode characters
 * Blocks: NULL bytes, various control characters, direction override characters
 */
function removeControlCharacters(str: string): string {
  // Remove NULL bytes, most control characters, and Unicode direction override
  // Replace with space to maintain word boundaries
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ") // ASCII control chars
    .replace(/[\u202E\u202D\u200E\u200F]/g, " ") // Unicode direction override
    .replace(/\uFEFF/g, ""); // Zero-width no-break space
}

/**
 * Removes excessive whitespace while preserving normal spacing
 */
function normalizeWhitespace(str: string): string {
  return str
    .replace(/\s+/g, " ") // Multiple spaces to single space
    .replace(/\n{3,}/g, "\n\n") // Max 2 consecutive newlines
    .trim();
}

/**
 * Comprehensive sanitization for user-generated text content
 * Protects against XSS, HTML injection, and various encoding attacks
 *
 * @param input - Raw user input string
 * @param options - Sanitization options
 * @returns Sanitized string safe for storage and display
 */
export function sanitizeText(
  input: string,
  options: {
    allowNewlines?: boolean;
    maxLength?: number;
    stripHtml?: boolean;
    encodeHtml?: boolean;
  } = {}
): string {
  const {
    allowNewlines = true,
    maxLength,
    stripHtml = true,
    encodeHtml = true,
  } = options;

  let sanitized = input;

  // Step 1: Remove control characters
  sanitized = removeControlCharacters(sanitized);

  // Step 2: Strip HTML tags if requested
  if (stripHtml) {
    sanitized = stripHtmlTags(sanitized);
  }

  // Step 3: Encode HTML entities if requested
  if (encodeHtml) {
    sanitized = encodeHtmlEntities(sanitized);
  }

  // Step 4: Normalize whitespace
  sanitized = normalizeWhitespace(sanitized);

  // Step 5: Remove newlines if not allowed
  if (!allowNewlines) {
    sanitized = sanitized.replace(/[\n\r]/g, " ");
  }

  // Step 6: Enforce max length if specified
  if (maxLength && sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }

  return sanitized;
}

/**
 * Sanitizes review comments with appropriate security measures
 * - Strips HTML tags
 * - Encodes special characters
 * - Allows newlines for readability
 * - Enforces length limits
 */
export function sanitizeReviewComment(comment: string, maxLength = 1000): string {
  return sanitizeText(comment, {
    allowNewlines: true,
    maxLength,
    stripHtml: true,
    encodeHtml: true,
  });
}

/**
 * Sanitizes user names with strict rules
 * - Strips HTML tags
 * - Encodes special characters
 * - No newlines allowed
 * - Limited length
 */
export function sanitizeUserName(name: string, maxLength = 100): string {
  return sanitizeText(name, {
    allowNewlines: false,
    maxLength,
    stripHtml: true,
    encodeHtml: true,
  });
}

/**
 * Sanitizes email addresses (basic validation)
 * Removes dangerous characters while preserving valid email format
 */
export function sanitizeEmail(email: string): string {
  // Remove control characters and HTML
  let sanitized = removeControlCharacters(email);
  sanitized = stripHtmlTags(sanitized);

  // Remove whitespace and normalize
  sanitized = sanitized.trim().toLowerCase();

  return sanitized;
}
