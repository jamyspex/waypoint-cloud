// Gemini API paid-tier (Standard) prices in USD, from aistudio.google.com/docs/pricing (read 2026-11-24).
// Thinking tokens are billed at the output rate. Google publishes no spend API for AI Studio prepay,
// so the cost screen prices the usage each response reports.
type Rate = { from?: string; input: number; output: number };
const perMillion: Record<string, Rate[]> = {
  "gemini-4-hydrogen": [{ input: 1.5, output: 7.5 }],
  "gemini-3.8-flash": [{ input: 0.75, output: 3.75 }, { from: "2027-01-01", input: 1.5, output: 7.5 }],
};

// Grounding with Google Search on Gemini 3 and newer: shared monthly free allowance, then per 1,000.
export const freeSearchesPerMonth = 5_000;
export const searchPricePerThousand = 14;

/** Token cost in USD for a model on a given day (YYYY-MM-DD); unknown models use Gemini 4 Hydrogen's rate. */
export function tokenCost(model: string, inputTokens: number, outputTokens: number, day: string): number {
  const rates = perMillion[model.replace(/^models\//, "")] ?? perMillion["gemini-4-hydrogen"];
  const rate = [...rates].reverse().find(({ from }) => !from || day >= from) ?? rates[0];
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

/** Search cost in USD for a month's searches so far, after the free allowance. */
export function searchCost(searches: number): number {
  return Math.max(0, searches - freeSearchesPerMonth) * searchPricePerThousand / 1000;
}
