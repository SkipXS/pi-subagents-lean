/**
 * Safe plaintext rendering for Agent-family tool rows.
 *
 * This module deliberately has no Pi/TUI dependency. It owns only terminal
 * escaping, conservative grapheme width calculation, wrapping, and the small
 * structural component used by the row renderer.
 */

/** Pi's structural component contract, kept local to avoid a TUI import. */
export interface PlaintextComponent {
  render(width: number): string[];
  invalidate(): void;
}

const graphemeSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

function graphemes(value: string): string[] {
  if (!graphemeSegmenter) return Array.from(value);
  return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
}

function graphemeWidth(grapheme: string): number {
  // Printable ASCII is always one cell. Treat every other grapheme cluster as
  // two cells: this intentionally overestimates combining-only and narrow
  // Unicode clusters, but never underestimates flags, keycaps, ZWJ emoji, or
  // East Asian characters. A conservative row is preferable to emitting a
  // line wider than Pi's viewport.
  return /^[\x20-\x7e]$/.test(grapheme) ? 1 : 2;
}

/** Calculate a conservative terminal-cell width for normal, ANSI-free text. */
export function visibleWidth(value: string): number {
  return graphemes(value).reduce((total, grapheme) => total + graphemeWidth(grapheme), 0);
}

/** Wrap without truncating, retaining every grapheme and explicit newline. */
export function wrapPlaintext(value: string, width: number): string[] {
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const lines: string[] = [];

  for (const logicalLine of value.split("\n")) {
    if (logicalLine.length === 0) {
      lines.push("");
      continue;
    }

    let line = "";
    let lineWidth = 0;
    for (const grapheme of graphemes(logicalLine)) {
      const nextWidth = graphemeWidth(grapheme);
      if (line && lineWidth + nextWidth > safeWidth) {
        lines.push(line);
        line = "";
        lineWidth = 0;
      }
      line += grapheme;
      lineWidth += nextWidth;
    }
    lines.push(line);
  }

  return lines.length > 0 ? lines : [""];
}

/**
 * Make arbitrary tool-controlled text safe for terminal output.
 *
 * Newline is retained only when it is the prompt's intentional line boundary;
 * every other C0/C1 control, ESC, and DEL becomes a visible \\xNN/\\t/\\r form.
 * Escaping ESC also breaks OSC/CSI sequences, including 8-bit OSC/CSI forms.
 */
export function escapeTerminalText(value: string, preserveNewlines = false): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (preserveNewlines && codePoint === 0x0a) {
      escaped += "\n";
    } else if (codePoint === 0x09) {
      escaped += "\\t";
    } else if (codePoint === 0x0d) {
      escaped += "\\r";
    } else if (codePoint <= 0x1f || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f)) {
      escaped += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

/** A small stateful plaintext component with conservative Unicode wrapping. */
export class AgentCallDetailsComponent implements PlaintextComponent {
  private value = "";
  private cachedWidth: number | undefined;
  private cachedValue: string | undefined;
  private cachedLines: string[] | undefined;

  /** Update the component only when its content really changed. */
  setText(value: string): boolean {
    const safeValue = escapeTerminalText(value, true);
    if (this.value === safeValue) return false;
    this.value = safeValue;
    this.invalidate();
    return true;
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
    if (this.cachedLines && this.cachedValue === this.value && this.cachedWidth === safeWidth) {
      return this.cachedLines;
    }
    const lines = wrapPlaintext(this.value, safeWidth);
    this.cachedValue = this.value;
    this.cachedWidth = safeWidth;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedValue = undefined;
    this.cachedLines = undefined;
  }
}
