// Port của lib/crypto.ts (chỉ phần decrypt — Edge Function không cần encrypt token) cho Deno.
import { createDecipheriv } from "node:crypto";
import { Buffer } from "node:buffer";

function getKey(): Uint8Array | null {
  const hex = Deno.env.get("TOKEN_ENC_KEY")?.trim();
  if (!hex) return null;
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENC_KEY phải là 64 ký tự hex (32 bytes) cho AES-256-GCM");
  }
  return key;
}

export function decryptToken(stored: string): string {
  const key = getKey();
  if (!stored.startsWith("v1:")) return stored; // chưa mã hoá -> trả nguyên
  if (!key) throw new Error("Token đã mã hoá nhưng thiếu TOKEN_ENC_KEY để giải mã");
  const [, ivHex, tagHex, dataHex] = stored.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}
