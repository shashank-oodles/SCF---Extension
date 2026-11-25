const GTI_RE = /amzn1\.dv\.gti\.[a-f0-9-]+/i;

export function isAmazonGti(value: string | null | undefined): boolean {
  if (!value) return false;
  return GTI_RE.test(value.trim());
}

export function extractAmazonGti(
  value: string | null | undefined
): string | undefined {
  if (!value) return undefined;
  const match = value.match(GTI_RE);
  return match ? match[0] : undefined;
}

export function normalizeGti(value: string): string {
  return value.trim().toLowerCase();
}
