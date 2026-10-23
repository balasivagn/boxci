import { protect } from "./process.js";

export const validKeyId = (id) => /^key_[A-Za-z0-9_]+$/.test(id || "");

export function keyMetadata(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !validKeyId(value.id) ||
    !Number.isFinite(Date.parse(value.expiresAt))
  )
    return null;
  return { id: value.id, expiresAt: value.expiresAt };
}

export function credentialResponse(result) {
  const secrets = new Set();
  const metadata = new Map();
  const visit = (value, field) => {
    if (typeof value === "string" && value.startsWith("ibk_")) {
      if (field !== "prefix") {
        protect(value);
        secrets.add(value);
      }
    } else if (value && typeof value === "object") {
      const meta = keyMetadata(value);
      if (meta) metadata.set(JSON.stringify(meta), meta);
      Object.entries(value).forEach(([name, child]) => visit(child, name));
    }
  };
  visit(result);
  if (secrets.size !== 1 || metadata.size > 1)
    throw new Error(
      "Unexpected credential response. No secret was transferred; rerun boxci init to review recovery.",
    );
  return { secret: [...secrets][0], meta: [...metadata.values()][0] || null };
}
