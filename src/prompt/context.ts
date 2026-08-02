/**
 * context.ts — Message content extraction helpers.
 *
 * Agent-runner response handling needs to extract text blocks from Pi message
 * content without depending on any presentation layer.
 */

function isTextBlock(c: unknown): c is { type: "text"; text: string } {
  return typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text";
}

/** Extract text from a message content block array. */
export function extractText(content: unknown[]): string {
  return content
    .filter(isTextBlock)
    .map((c) => c.text)
    .join("\n");
}
