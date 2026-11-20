// Advance widths for the stock printable ASCII font used by the firmware.
const advances = [4, 2, 4, 6, 6, 5, 6, 2, 4, 4, 6, 6, 3, 4, 2, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 2, 3, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 4, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 3, 5, 9, 4, 5, 3, 6, 6, 6, 6, 6, 5, 6, 6, 4, 5, 5, 4, 6, 6, 6, 6, 6, 6, 6, 5, 6, 6, 6, 6, 6, 6, 4, 2, 4, 6];

export function textWidth(text: string): number {
  return [...text].reduce((sum, character) => sum + (advances[character.charCodeAt(0) - 32] ?? 6), 0);
}
