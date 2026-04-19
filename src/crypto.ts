// ============================================================================
// Netease weapi Encryption
// Reverse-engineered from music.163.com client JS
// Algorithm: AES-128-CBC(AES-128-CBC(text, presetKey), randomKey) + RSA-NO_PADDING(randomKey)
// ============================================================================

const PRESET_KEY = '0CoJUm6Qyw8W8jud'
const IV = '0102030405060708'
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

// RSA-1024 public key (extracted from music.163.com/weapi DER)
const RSA_N = BigInt(
  '0xe0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b7251' +
    '52b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312e' +
    'cbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d' +
    '813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7',
)
const RSA_E = 65537n

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n
  base = base % mod
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod
    exp >>= 1n
    base = (base * base) % mod
  }
  return result
}

/** Generate a random 16-byte key using base62 charset. */
export function randomSecretKey(): Uint8Array {
  const rand = new Uint8Array(16)
  crypto.getRandomValues(rand)
  const key = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    key[i] = BASE62.charCodeAt(rand[i]! % 62)
  }
  return key
}

async function aesCbcEncrypt(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer, { name: 'AES-CBC' }, false, ['encrypt'])
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer }, cryptoKey, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
  return new Uint8Array(encrypted)
}

function uint8ToBase64(arr: Uint8Array): string {
  let binary = ''
  for (const byte of arr) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function rsaEncrypt(secretKey: Uint8Array): string {
  // RSA NO_PADDING: reverse key bytes, left-pad to 128 bytes, compute m^e mod n
  const reversed = new Uint8Array([...secretKey].reverse())
  const padded = new Uint8Array(128)
  padded.set(reversed, 128 - reversed.length)
  const m = BigInt('0x' + [...padded].map((b) => b.toString(16).padStart(2, '0')).join(''))
  const r = modPow(m, RSA_E, RSA_N)
  return r.toString(16).padStart(256, '0')
}

/**
 * Encrypt params using weapi algorithm.
 * Returns { params (base64), encSecKey (hex) } suitable for POST body.
 */
export async function weapi(
  params: Record<string, unknown>,
): Promise<{ params: string; encSecKey: string }> {
  const text = JSON.stringify(params)
  const secretKey = randomSecretKey()
  const ivBytes = new TextEncoder().encode(IV)
  const presetKeyBytes = new TextEncoder().encode(PRESET_KEY)

  // Step 1: AES-128-CBC encrypt text with PRESET_KEY → base64
  const step1 = await aesCbcEncrypt(new TextEncoder().encode(text), presetKeyBytes, ivBytes)
  const step1B64 = uint8ToBase64(step1)

  // Step 2: AES-128-CBC encrypt step1 base64 with random secretKey → base64
  const step2 = await aesCbcEncrypt(new TextEncoder().encode(step1B64), secretKey, ivBytes)

  return {
    params: uint8ToBase64(step2),
    encSecKey: rsaEncrypt(secretKey),
  }
}

/** Build URL-encoded POST body for weapi request. */
export async function buildWEApiBody(params: Record<string, unknown>): Promise<string> {
  const { params: p, encSecKey } = await weapi(params)
  return new URLSearchParams({ params: p, encSecKey }).toString()
}
