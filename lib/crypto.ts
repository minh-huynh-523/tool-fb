import crypto from 'node:crypto';

// AES-256-GCM mã hoá token at-rest. Định dạng lưu: `v1:<iv_hex>:<tag_hex>:<ciphertext_hex>`.
// Nếu TOKEN_ENC_KEY trống -> passthrough (lưu plaintext, không khuyến nghị nhưng vẫn chạy).

const KEY_HEX = process.env.TOKEN_ENC_KEY?.trim();

function getKey(): Buffer | null {
  if (!KEY_HEX) return null;
  const key = Buffer.from(KEY_HEX, 'hex');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENC_KEY phải là 64 ký tự hex (32 bytes) cho AES-256-GCM');
  }
  return key;
}

export function encryptToken(plain: string): string {
  const key = getKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptToken(stored: string): string {
  const key = getKey();
  // Chưa mã hoá (copy tay plaintext vào Supabase) -> trả nguyên
  if (!stored.startsWith('v1:')) return stored;
  if (!key) throw new Error('Token đã mã hoá nhưng thiếu TOKEN_ENC_KEY để giải mã');
  const [, ivHex, tagHex, dataHex] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
