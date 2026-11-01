import { validFamily, fontAlias, trustedFontUrl, readBounded } from '../src/font-policy.js';

// Only family/style metadata is proxied. Source and font binaries never enter this route.
export async function googleFontMetadata(query, fetcher = fetch) {
  const { family, weight, italic } = query;
  if (!validFamily(family) || typeof weight !== 'string' || !/^[1-9]00$/.test(weight) || !['0', '1'].includes(italic))
    return { status: 400, error: 'Use a literal Google Fonts family, weight 100-900, and italic 0 or 1.' };
  const style = `${weight}${italic === '1' ? 'i' : ''}`;
  const signal = AbortSignal.timeout(10000);
  async function cssFor(name, fontWeight, slanted) {
    const url = new URL('https://fonts.googleapis.com/css');
    url.searchParams.set('family', `${name}:${fontWeight}${slanted ? 'i' : ''}`);
    const response = await fetcher(url.href, {
      headers: { 'User-Agent': 'KhanhhNeLatex/1.0 (TrueType TeX fonts)' }, redirect: 'manual', signal,
    });
    if (response.status === 400) return null;
    return new TextDecoder().decode(await readBounded(response, 64000));
  }
  try {
    let actualWeight = Number(weight);
    let actualItalic = italic === '1';
    let css = await cssFor(family, actualWeight, actualItalic);
    if (css === null) {
      const alias = fontAlias(family);
      // Exact family names (e.g. Archivo Black) always win; absent styles are not aliases.
      const exists = (weight !== '400' || italic !== '0') && await cssFor(family, 400, false);
      if (alias && !exists) {
        actualWeight = alias.weight === 400 ? actualWeight : alias.weight;
        actualItalic ||= alias.italic;
        css = await cssFor(alias.family, actualWeight, actualItalic);
      }
    }
    if (css === null) return { status: 404, error: `Google Fonts has no ${family} face at ${style}. Check the family/style spelling.` };
    const blocks = css.match(/@font-face\s*\{[^}]+\}/g) || [];
    const match = blocks.find(block =>
      block.includes(`font-weight: ${actualWeight};`) &&
      block.includes(`font-style: ${actualItalic ? 'italic' : 'normal'};`));
    const fontUrl = match?.match(/src:\s*url\((https:[^)]+)\)\s*format\(['"]truetype['"]\)/)?.[1];
    if (!trustedFontUrl(fontUrl)) return { status: 422, error: `Google Fonts did not provide a static TrueType face for ${family} ${style}. This browser TeX engine cannot use WOFF2 or variable-only fonts.` };
    return { status: 200, family, weight: Number(weight), italic: italic === '1', url: fontUrl };
  } catch (error) {
    console.error('Google Fonts metadata request failed', { reason: error.name, message: error.message.slice(0, 240) });
    return { status: 502, error: 'Google Fonts metadata is unavailable or timed out. Check the connection and try compiling again.' };
  }
}
