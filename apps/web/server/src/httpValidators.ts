/** If-None-Match 用弱比较。W/ 前缀和逗号分隔的多个值都算命中。 */
export function ifNoneMatchSatisfied(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const parts = header.split(",");
  if (parts.some((part) => part.trim() === "*")) return true;
  const want = stripWeak(etag);
  return parts.some((part) => stripWeak(part) === want);
}

function stripWeak(value: string): string {
  return value.trim().replace(/^W\//i, "");
}
