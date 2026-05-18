import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

import { AdoError } from "./errors.js";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const candidates = [
    Buffer.from(trimmed, "base64"),
    Buffer.from(trimmed, "hex"),
    Buffer.from(trimmed, "utf8")
  ];
  const key = candidates.find((candidate) => candidate.length === 32);
  if (key === undefined) {
    throw new AdoError(
      "TOKEN_ENCRYPTION_KEY must decode to 32 bytes using base64, hex, or utf8.",
      { kind: "configuration" }
    );
  }
  return key;
}

export function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

export function decryptSecret(value: string, key: Buffer): string {
  const [version, iv, tag, encrypted] = value.split(".");
  if (
    version !== "v1" ||
    iv === undefined ||
    tag === undefined ||
    encrypted === undefined
  ) {
    throw new AdoError("Encrypted token payload is malformed.", {
      kind: "configuration"
    });
  }

  const decipher = createDecipheriv(
    ENCRYPTION_ALGORITHM,
    key,
    Buffer.from(iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

export function timingSafeEqualString(left: string, right: string): boolean {
  const leftHash = sha256(left);
  const rightHash = sha256(right);
  return leftHash === rightHash;
}

export function signValue(value: string, secret: string): string {
  const signature = createHmac("sha256", secret)
    .update(value)
    .digest("base64url");
  return `${value}.${signature}`;
}

export function verifySignedValue(
  signedValue: string,
  secret: string
): string | undefined {
  const separator = signedValue.lastIndexOf(".");
  if (separator <= 0) {
    return undefined;
  }
  const value = signedValue.slice(0, separator);
  const signature = signedValue.slice(separator + 1);
  const expected = createHmac("sha256", secret)
    .update(value)
    .digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    return undefined;
  }
  return timingSafeEqual(left, right) ? value : undefined;
}
