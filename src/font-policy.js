export const MAX_FONT_BYTES = 8 * 1024 * 1024;
export const MAX_JOB_FONT_BYTES = 24 * 1024 * 1024;
export const MAX_FONT_FACES = 16;

export function validFamily(family) {
  return typeof family === 'string' && family.length <= 80 &&
    /^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(family) && family === family.trim();
}

export function fontAlias(name) {
  let family = name;
  let italic = false;
  if (family.endsWith(' Italic')) { family = family.slice(0, -7); italic = true; }
  let weight = 400;
  for (const [suffix, value] of Object.entries({ Thin: 100, ExtraLight: 200, Light: 300, Regular: 400, Medium: 500, SemiBold: 600, Bold: 700, ExtraBold: 800, Black: 900 })) {
    if (family.endsWith(` ${suffix}`)) { family = family.slice(0, -suffix.length - 1); weight = value; break; }
  }
  return family === name ? null : { family, weight, italic };
}

export function trustedFontUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://fonts.gstatic.com' && !url.username && !url.password &&
      !url.search && !url.hash && /^\/s\/[a-z0-9]+\/v\d+\/[A-Za-z0-9_-]+\.ttf$/.test(url.pathname);
  } catch { return false; }
}

export async function readBounded(response, limit) {
  if (!response.ok) throw new Error(`Font request failed (HTTP ${response.status}).`);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Font response exceeds the download limit.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Font response exceeds the download limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
