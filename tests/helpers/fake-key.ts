// Builds fake credentials at runtime. Test sources must never hold a contiguous
// key-shaped literal: `npm run check:secrets` scans tests/ like any other folder.
export function fakeOpenAiKey(fill = "A"): string {
  return ["sk", "proj", fill.repeat(32)].join("-");
}
