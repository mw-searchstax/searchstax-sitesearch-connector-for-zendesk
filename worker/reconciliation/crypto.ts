import { ContractError } from "../contracts/shared.ts";

export interface EncryptedEnvelope {
  version: 1;
  iv: string;
  ciphertext: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new ContractError(
      "INVALID_CREDENTIAL_ENVELOPE",
      "Credential envelope was invalid.",
    );
  }
}

function encryptionKey(rawKey: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(rawKey.trim());
  if (bytes.byteLength !== 32) {
    throw new ContractError(
      "INVALID_ENCRYPTION_KEY",
      "Configuration encryption key must contain exactly 32 bytes.",
    );
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptConfiguration(
  value: unknown,
  rawKey: string,
  randomBytes: (length: number) => Uint8Array<ArrayBuffer> = (length) =>
    crypto.getRandomValues(new Uint8Array(length)),
): Promise<EncryptedEnvelope> {
  const iv = randomBytes(12);
  if (iv.byteLength !== 12)
    throw new ContractError(
      "INVALID_RANDOM_SOURCE",
      "Configuration encryption IV was invalid.",
    );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(rawKey),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return {
    version: 1,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptConfiguration<T>(
  envelope: EncryptedEnvelope,
  rawKey: string,
): Promise<T> {
  if (
    envelope.version !== 1 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new ContractError(
      "INVALID_CREDENTIAL_ENVELOPE",
      "Credential envelope was invalid.",
    );
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
      await encryptionKey(rawKey),
      base64ToBytes(envelope.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError(
      "CREDENTIAL_DECRYPTION_FAILED",
      "Stored credentials could not be decrypted.",
    );
  }
}
