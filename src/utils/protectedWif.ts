// Ecto 2.0.0 uses a fresh extension key and storage namespace, so this file
// implements exactly one protected-secret format and intentionally omits any
// compatibility layer for older encrypted account payloads.
const PROTECTED_WIF_FORMAT = "ecto.protected-wif";
const PROTECTED_WIF_VERSION = 1;
// PBKDF2-SHA256 is used intentionally because it is available in standard Web
// Crypto APIs and avoids adding extra cryptographic dependencies to the
// extension bundle. The iteration count is set well above the legacy scheme
// while keeping popup unlock/signing latency practical for an extension UI.
const PBKDF2_ITERATIONS = 250000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface ProtectedWifPayload {
  format: typeof PROTECTED_WIF_FORMAT;
  version: typeof PROTECTED_WIF_VERSION;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  cipher: "AES-GCM-256";
  saltBase64: string;
  ivBase64: string;
  ciphertextBase64: string;
}

function getWebCrypto(): Crypto {
  const cryptoApi = globalThis.crypto;

  if (!cryptoApi || !cryptoApi.subtle) {
    throw new Error("Web Crypto API is not available");
  }

  return cryptoApi;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function deriveAesKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
  usage: KeyUsage[]
): Promise<CryptoKey> {
  const cryptoApi = getWebCrypto();
  const passwordKey = await cryptoApi.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return cryptoApi.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    passwordKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    usage
  );
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getWebCrypto().getRandomValues(bytes);
  return bytes;
}

export function isProtectedWifPayload(value: unknown): value is ProtectedWifPayload {
  const candidate = value as ProtectedWifPayload | undefined;

  // Strict format checks are deliberate: since this extension generation has no
  // migration path, anything outside this schema must fail closed.
  return !!candidate &&
    candidate.format === PROTECTED_WIF_FORMAT &&
    candidate.version === PROTECTED_WIF_VERSION &&
    candidate.kdf === "PBKDF2-SHA256" &&
    candidate.cipher === "AES-GCM-256" &&
    Number.isInteger(candidate.iterations) &&
    candidate.iterations > 0 &&
    typeof candidate.saltBase64 === "string" &&
    typeof candidate.ivBase64 === "string" &&
    typeof candidate.ciphertextBase64 === "string";
}

export async function protectWifWithPassword(
  wif: string,
  password: string
): Promise<ProtectedWifPayload> {
  if (!password) {
    throw new Error("Password is required to protect a stored wallet");
  }

  const cryptoApi = getWebCrypto();
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);

  // The payload carries explicit algorithm metadata so future storage revisions
  // do not rely on hidden assumptions or magic constants.
  const key = await deriveAesKey(password, salt, PBKDF2_ITERATIONS, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await cryptoApi.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
      },
      key,
      textEncoder.encode(wif)
    )
  );

  return {
    format: PROTECTED_WIF_FORMAT,
    version: PROTECTED_WIF_VERSION,
    kdf: "PBKDF2-SHA256",
    iterations: PBKDF2_ITERATIONS,
    cipher: "AES-GCM-256",
    saltBase64: bytesToBase64(salt),
    ivBase64: bytesToBase64(iv),
    ciphertextBase64: bytesToBase64(ciphertext),
  };
}

export async function revealProtectedWifWithPassword(
  payload: ProtectedWifPayload,
  password: string
): Promise<string> {
  if (!isProtectedWifPayload(payload)) {
    throw new Error("Unsupported protected wallet format");
  }

  const cryptoApi = getWebCrypto();
  const salt = base64ToBytes(payload.saltBase64);
  const iv = base64ToBytes(payload.ivBase64);
  const ciphertext = base64ToBytes(payload.ciphertextBase64);

  try {
    const key = await deriveAesKey(password, salt, payload.iterations, ["decrypt"]);
    const plaintext = await cryptoApi.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
      },
      key,
      ciphertext
    );

    return textDecoder.decode(plaintext);
  } catch {
    // Callers intentionally collapse wrong-password and corrupted-payload cases
    // into the same user-facing message so the popup does not leak oracle hints.
    throw new Error("Could not decrypt protected wallet secret");
  }
}
