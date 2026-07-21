function slugifyIdentifier(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function buildApplicationUniqueId(namespace, identity, nonce = "") {
  const prefix = slugifyIdentifier(namespace) || "application";
  const subject = slugifyIdentifier(identity) || "instance";
  const discriminator = slugifyIdentifier(nonce);
  return [prefix, subject, discriminator].filter(Boolean).join("-");
}
