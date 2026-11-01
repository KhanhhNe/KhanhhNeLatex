import { validFamily, fontAlias, trustedFontUrl, readBounded, MAX_FONT_BYTES, MAX_JOB_FONT_BYTES, MAX_FONT_FACES } from './font-policy.js';

// Replace ignored regions with spaces so replacement offsets still refer to the original source.
export function fontSource(source) {
  const visible = source.split('');
  const hide = (start, end) => {
    for (let i = start; i < end; i++) if (visible[i] !== '\r' && visible[i] !== '\n') visible[i] = ' ';
  };
  for (let i = 0; i < source.length;) {
    if (source[i] === '%') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      hide(i, stop); i = stop;
    } else if (source[i] === '\\') {
      if (source[i + 1] === '%') { i += 2; continue; }
      if (source[i + 1] === '\\') { hide(i, i + 2); i += 2; continue; }
      const environment = ['verbatim*', 'verbatim', 'lstlisting', 'minted']
        .find(name => source.startsWith(`\\begin{${name}}`, i));
      if (environment) {
        const closing = `\\end{${environment}}`;
        const end = source.indexOf(closing, i + environment.length + 8);
        const stop = end < 0 ? source.length : end + closing.length;
        hide(i, stop); i = stop;
      } else if (source.startsWith('\\verb', i)) {
        const delimiterAt = i + (source[i + 5] === '*' ? 6 : 5);
        const delimiter = source[delimiterAt];
        if (delimiter && /[^A-Za-z\s]/.test(delimiter)) {
          const closing = source.indexOf(delimiter, delimiterAt + 1);
          const newline = source.indexOf('\n', delimiterAt + 1);
          const stop = closing >= 0 && (newline < 0 || closing < newline) ? closing + 1 : newline < 0 ? source.length : newline;
          hide(i, stop); i = stop;
        } else i++;
      } else i++;
    } else i++;
  }
  return visible.join('');
}

function group(text, start, open, close) {
  if (text[start] !== open) throw new Error('Font declarations must use literal braced family names.');
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return { value: text.slice(start + 1, i), end: i + 1 };
  }
  throw new Error('Unclosed font declaration. Check its braces and brackets.');
}

export function fontFace(name) {
  const family = name.trim().replace(/\s+/g, ' ');
  if (!validFamily(family)) throw new Error('Font names must be literal Google Fonts family names (letters, digits, spaces or hyphens; at most 80 characters). URLs, paths and TeX macros are not supported.');
  return { family, weight: 400, italic: false, key: `${family.toLowerCase()}:400:0` };
}

export function detectFonts(source) {
  if (typeof source !== 'string' || source.length > 100000) throw new Error('Compile a text document of at most 100,000 characters.');
  const text = fontSource(source);
  const declarations = [];
  const regex = /\\(setmainfont|setsansfont|setmonofont|newfontfamily|fontspec)\b/g;
  let match;
  while ((match = regex.exec(text))) {
    let pos = regex.lastIndex;
    const space = () => { while (/\s/.test(text[pos] || '') && pos < text.length) pos++; };
    space();
    if (match[1] === 'newfontfamily') {
      const command = text.slice(pos).match(/^(?:\\[A-Za-z]+|\{\\[A-Za-z]+\})/);
      if (!command) throw new Error('Use \\newfontfamily\\name{Google Family}. Computed font commands are unsupported.');
      pos += command[0].length; space();
    }
    let options = '';
    if (text[pos] === '[') { const value = group(text, pos, '[', ']'); options = value.value; pos = value.end; space(); }
    const family = group(text, pos, '{', '}');
    if (text.slice(family.end).match(/^\s*\[/)) throw new Error('Put font options before the braced family name, for example \\setmainfont[BoldFont={Roboto Bold}]{Roboto}.');
    const upright = fontFace(family.value);
    const faces = { UprightFont: upright };
    if (options) {
      if (options.length > 512) throw new Error('Font options exceed the 512-character limit.');
      for (const option of options.split(/,(?![^{}]*\})/)) {
        const value = option.trim().match(/^(UprightFont|BoldFont|ItalicFont|BoldItalicFont)\s*=\s*(?:\{([^{}]+)\}|([^{}]+))$/);
        if (!value) throw new Error('Supported font options: UprightFont, BoldFont, ItalicFont and BoldItalicFont with literal family/style names. Other fontspec options are not supported.');
        faces[value[1]] = fontFace(value[2] || value[3]);
      }
    }
    declarations.push({ start: match.index, end: family.end, prefix: text.slice(match.index, pos).replace(/\[[\s\S]*\]\s*$/, ''), faces });
    regex.lastIndex = family.end;
  }
  if (!declarations.length && /\\usepackage(?:\[[^\]]*\])?\{[^}]*\bfontspec\b/.test(text))
    throw new Error('Add a literal \\setmainfont{Google Family} declaration when using fontspec.');
  return declarations;
}

export class GoogleFontLoader {
  constructor({ fetcher = (...args) => fetch(...args), cacheStorage = globalThis.caches } = {}) {
    this.fetcher = fetcher;
    this.cacheStorage = cacheStorage;
    this.memory = new Map();
    this.memoryUrls = new Map();
    this.memoryBytes = 0;
  }

  async face(face, signal) {
    signal.throwIfAborted();
    const cached = this.memory.get(face.key);
    if (cached) return cached;
    const alias = fontAlias(face.family);
    if (face.family === 'Latin Modern Roman' || alias?.family === 'Latin Modern Roman') {
      const weight = alias && alias.weight !== 400 ? alias.weight : face.weight;
      const italic = face.italic || alias?.italic;
      if (![400, 700].includes(weight)) throw new Error('Bundled Latin Modern Roman supports regular, bold, italic and bold italic only.');
      const style = weight === 700 ? italic ? 'bolditalic' : 'bold' : italic ? 'italic' : 'regular';
      const bytes = await readBounded(await this.fetcher(`/compiler/native-tex/lmroman10-${style}.otf`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), credentials: 'omit', redirect: 'error',
      }), MAX_FONT_BYTES);
      signal.throwIfAborted();
      if (new TextDecoder().decode(bytes.slice(0, 4)) !== 'OTTO') throw new Error('The bundled Latin Modern font could not be loaded. Retry compilation.');
      face.extension = 'otf';
      return bytes;
    }
    const metadataUrl = `/api/fonts?family=${encodeURIComponent(face.family)}&weight=${face.weight}&italic=${Number(face.italic)}`;
    let cache;
    try { cache = await this.cacheStorage?.open('google-tex-fonts-v1'); }
    catch (error) { console.warn('Persistent font cache unavailable', error.name); }
    let saved;
    try { saved = await cache?.match(metadataUrl); }
    catch (error) { console.warn('Font cache read failed', error.name); }
    let response = saved;
    let fontUrl = saved?.headers.get('X-Font-Url');
    if (!saved) {
      const metadataResponse = await this.fetcher(metadataUrl, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), credentials: 'omit', redirect: 'error',
      });
      const metadataBytes = await readBounded(new Response(metadataResponse.body), 64000);
      const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
      if (!metadataResponse.ok) throw new Error(metadata.error || `Font metadata request failed (HTTP ${metadataResponse.status}).`);
      if (!trustedFontUrl(metadata.url) || metadata.family !== face.family || metadata.weight !== face.weight || metadata.italic !== face.italic)
        throw new Error('The font service returned an unsafe or mismatched font face.');
      fontUrl = metadata.url;
      const reusedKey = [...this.memoryUrls.keys()].find(key => this.memoryUrls.get(key) === fontUrl);
      response = reusedKey ? new Response(this.memory.get(reusedKey)) : await this.fetcher(fontUrl, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      });
    }
    if (!trustedFontUrl(fontUrl)) throw new Error('The font cache contains an unsafe font URL. Clear the device font cache and retry.');
    const bytes = await readBounded(response, MAX_FONT_BYTES);
    signal.throwIfAborted();
    if (bytes.length < 12 || new DataView(bytes.buffer).getUint32(0) !== 0x00010000)
      throw new Error(`${face.family} did not return a supported TrueType font. No substitute was used.`);
    const view = new DataView(bytes.buffer);
    const tableCount = view.getUint16(4);
    if (!tableCount || tableCount > 256 || 12 + tableCount * 16 > bytes.length)
      throw new Error(`${face.family} returned an invalid TrueType table directory.`);
    for (let index = 0; index < tableCount; index++) {
      const offset = 12 + index * 16;
      if (view.getUint32(offset) === 0x66766172)
        throw new Error(`${face.family} returned a variable font. This pinned engine requires static TrueType faces; no default-axis substitute was used.`);
      if (view.getUint32(offset + 8) + view.getUint32(offset + 12) > bytes.length)
        throw new Error(`${face.family} returned a truncated TrueType font.`);
    }
    // Never let optional device caching turn a successful download into a failed compile.
    if (cache && !saved) {
      try {
        const keys = await cache.keys();
        let cacheBytes = 0;
        for (const key of keys) cacheBytes += Number((await cache.match(key))?.headers.get('Content-Length')) || MAX_FONT_BYTES;
        while (keys.length >= MAX_FONT_FACES || cacheBytes + bytes.length > MAX_JOB_FONT_BYTES) {
          const key = keys.shift();
          if (!key) break;
          cacheBytes -= Number((await cache.match(key))?.headers.get('Content-Length')) || MAX_FONT_BYTES;
          await cache.delete(key);
        }
        await cache.put(metadataUrl, new Response(bytes, { headers: {
          'Content-Type': 'font/ttf', 'Content-Length': String(bytes.length), 'X-Font-Url': fontUrl,
        } }));
      } catch (error) { console.warn('Font cache write failed', error.name); }
    }
    while (this.memoryBytes + bytes.length > MAX_JOB_FONT_BYTES && this.memory.size) {
      const key = this.memory.keys().next().value;
      this.memoryBytes -= this.memory.get(key).length;
      this.memory.delete(key);
      this.memoryUrls.delete(key);
    }
    this.memory.set(face.key, bytes);
    this.memoryUrls.set(face.key, fontUrl);
    this.memoryBytes += bytes.length;
    return bytes;
  }

  async prepare(source, declarations, signal, onStatus) {
    const text = fontSource(source);
    const bold = /\\(?:textbf|bfseries|bf|section|subsection|subsubsection|chapter|part|maketitle)\b/.test(text);
    const italic = /\\(?:textit|itshape|it|emph|slshape|textsl)\b/.test(text);
    const faces = new Map();
    const styled = (face, weight, italic) => ({ family: face.family, weight, italic, key: `${face.family.toLowerCase()}:${weight}:${Number(italic)}` });
    for (const declaration of declarations) {
      const upright = declaration.faces.UprightFont;
      if (bold && !declaration.faces.BoldFont)
        declaration.faces.BoldFont = styled(upright, 700, false);
      if (italic && !declaration.faces.ItalicFont) declaration.faces.ItalicFont = styled(upright, 400, true);
      if (bold && italic && !declaration.faces.BoldItalicFont) declaration.faces.BoldItalicFont = styled(upright, 700, true);
      for (const face of Object.values(declaration.faces)) if (!faces.has(face.key)) faces.set(face.key, face);
    }
    if (faces.size > MAX_FONT_FACES) throw new Error(`Use at most ${MAX_FONT_FACES} distinct font faces per document.`);
    const files = [];
    let total = 0;
    for (const face of faces.values()) {
      signal.throwIfAborted();
      onStatus(`Downloading ${face.family} ${face.weight}${face.italic ? ' italic' : ''}...`);
      const bytes = await this.face(face, signal);
      total += bytes.length;
      if (total > MAX_JOB_FONT_BYTES) throw new Error('Fonts exceed the 24 MiB per-document limit.');
      face.filename = `googlefont${files.length}.${face.extension || 'ttf'}`;
      files.push({ filename: face.filename, bytes });
    }
    let prepared = source;
    for (const declaration of [...declarations].reverse()) {
      const names = Object.entries(declaration.faces).filter(([style]) => style !== 'UprightFont')
        .map(([style, face]) => `${style}=${faces.get(face.key).filename}`);
      // Explicit empty styles prevent fontspec's automatic system-font lookup/substitution.
      for (const style of ['BoldFont', 'ItalicFont', 'BoldItalicFont']) {
        if (!declaration.faces[style]) names.push(`${style}={}`);
      }
      const replacement = `${declaration.prefix}[${names.join(',')}]{${faces.get(declaration.faces.UprightFont.key).filename}}`;
      prepared = prepared.slice(0, declaration.start) + replacement + prepared.slice(declaration.end);
    }
    return { source: `\\tracinglostchars=2\n\\AtBeginDocument{\\tracinglostchars=2}\n${prepared}`, files };
  }
}
