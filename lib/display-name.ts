export function publicBusinessName(name: string) {
  const cleaned = name
    .replace(/\bdemo\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "Relay NW";
}
