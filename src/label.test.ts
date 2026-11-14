import { describe, expect, it } from "vitest";
import { textBoxFor, wrapName } from "./label";

const BOX = { lineChars: 11, maxLines: 4 };

describe("wrapName", () => {
  it("keeps a short name on one line", () => {
    expect(wrapName("Router", BOX)).toEqual(["Router"]);
  });

  it("wraps at word boundaries without exceeding the line length", () => {
    const lines = wrapName("IKEA of Sweden TRADFRI Signal Repeater", BOX);
    expect(lines.join(" ")).toContain("IKEA of");
    expect(lines.every((line) => line.length <= BOX.lineChars)).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(BOX.maxLines);
  });

  it("cuts a single word that is too long and marks the cut", () => {
    const [line] = wrapName("_TZE200_xuzcvlku", BOX);
    expect(line).toHaveLength(BOX.lineChars);
    expect(line?.endsWith("\u2026")).toBe(true);
  });

  it("ends the last line with an ellipsis when the name needs more than the lines allow", () => {
    const lines = wrapName("alpha bravo charlie delta echo foxtrot golf hotel india juliet", BOX);
    expect(lines).toHaveLength(BOX.maxLines);
    expect(lines[BOX.maxLines - 1]?.endsWith("\u2026")).toBe(true);
  });

  it("returns no lines for an empty name", () => {
    expect(wrapName("   ", BOX)).toEqual([]);
  });
});

describe("textBoxFor", () => {
  it("fits fewer, shorter lines into a smaller node", () => {
    const big = textBoxFor(31, 11);
    const small = textBoxFor(20, 11);
    expect(big.lineChars).toBeGreaterThan(small.lineChars);
    expect(big.maxLines).toBeGreaterThanOrEqual(small.maxLines);
  });

  it("never returns a box too small to hold anything", () => {
    expect(textBoxFor(1, 11)).toEqual({ lineChars: 3, maxLines: 1 });
  });
});
