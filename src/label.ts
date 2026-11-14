/** Average width of a character as a fraction of the font size. */
const CHAR_WIDTH_EM = 0.56;
/** Line height as a multiple of the font size. */
export const LINE_HEIGHT_EM = 1.15;

/** How much of a node's diameter the text may use across, and down; text near the rim is cut by the circle. */
const USABLE_ACROSS = 0.82;
const USABLE_DOWN = 0.9;

export interface TextBox {
  /** Characters per line. */
  lineChars: number;
  /** Lines. */
  maxLines: number;
}

/** What fits inside a circle of this radius at this font size, both in the same units, never less than one short line. */
export function textBoxFor(radius: number, fontSize: number): TextBox {
  return {
    lineChars: Math.max(Math.floor((2 * radius * USABLE_ACROSS) / (fontSize * CHAR_WIDTH_EM)), 3),
    maxLines: Math.max(Math.floor((2 * radius * USABLE_DOWN) / (fontSize * LINE_HEIGHT_EM)), 1),
  };
}

/**
 * Breaks a device name into at most `maxLines` lines of `lineChars` characters for the inside of a node, cutting
 * a word that is too long and ending with an ellipsis when the name does not fit.
 */
export function wrapName(name: string, { lineChars, maxLines }: TextBox): string[] {
  const lines: string[] = [];
  let current = "";
  const words = name.split(/\s+/).filter((word) => word.length > 0);
  for (const word of words) {
    const piece = word.length > lineChars ? `${word.slice(0, lineChars - 1)}\u2026` : word;
    if (current === "") {
      current = piece;
    } else if (current.length + 1 + piece.length <= lineChars) {
      current = `${current} ${piece}`;
    } else {
      lines.push(current);
      current = piece;
    }
  }
  if (current !== "") {
    lines.push(current);
  }
  if (lines.length <= maxLines) {
    return lines;
  }
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? "";
  kept[maxLines - 1] = `${last.slice(0, lineChars - 1)}\u2026`;
  return kept;
}
