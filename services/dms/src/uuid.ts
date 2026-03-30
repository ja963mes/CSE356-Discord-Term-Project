import { randomUUID, createHash } from "crypto";

export { randomUUID as uuidv4 };

// UUID v5 (SHA1-based, name-spaced) — matches the behaviour of the `uuid` package's uuidv5(name, uuidv5.URL)
const URL_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

export function uuidv5(name: string, namespace: string = URL_NAMESPACE): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(nsBytes).update(Buffer.from(name, "utf8")).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant bits
  const h = hash.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Convenience namespace constant matching uuid package's uuidv5.URL
uuidv5.URL = URL_NAMESPACE;
