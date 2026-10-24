/**
 * Minimal line diff (LCS) producing a unified-style text with +/- markers.
 * Good enough for small source files; no dependency.
 */
export function lineDiff(before: string, after: string): { text: string; added: number; removed: number } {
  const a = before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${a[i++]}`);
      removed++;
    } else {
      out.push(`+ ${b[j++]}`);
      added++;
    }
  }
  while (i < n) {
    out.push(`- ${a[i++]}`);
    removed++;
  }
  while (j < m) {
    out.push(`+ ${b[j++]}`);
    added++;
  }
  return { text: out.join("\n"), added, removed };
}
