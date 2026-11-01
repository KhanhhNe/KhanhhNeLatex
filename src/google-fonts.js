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
  const filename = family.match(/^([A-Z][a-z]+(?:[A-Z][a-z]+)*)-(Regular|Bold|Italic|BoldItalic)\.ttf$/);
  if (filename && family.length <= 80) {
    const resolved = filename[1].replace(/([a-z])([A-Z])/g, '$1 $2');
    const weight = filename[2].startsWith('Bold') ? 700 : 400;
    const italic = filename[2].endsWith('Italic');
    return { family: resolved, weight, italic, key: `${resolved.toLowerCase()}:${weight}:${Number(italic)}`, virtualFile: family };
  }
  if (!validFamily(family)) throw new Error('Font names must resolve to literal Google Fonts family names (letters, digits, spaces or hyphens; at most 80 characters). URLs, paths and computed TeX names are not supported.');
  return { family, weight: 400, italic: false, key: `${family.toLowerCase()}:400:0` };
}

export function usesFontspec(source) {
  return /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{[^}]*\bfontspec\b/.test(fontSource(source));
}

function fontMacros(text) {
  const definitions = [];
  const tokens = /\\(?:(?:newcommand|renewcommand|providecommand)\b\*?|(?:def|gdef|edef|xdef|let)\b)|\\if[A-Za-z@]*\b|\\fi\b|[{}]/g;
  let depth = 0;
  let conditional = 0;
  let match;
  while ((match = tokens.exec(text))) {
    const token = match[0].replace(/\*$/, '');
    if (token === '{') { depth++; continue; }
    if (token === '}') { depth--; continue; }
    if (token === '\\fi') { conditional = Math.max(0, conditional - 1); continue; }
    if (token.startsWith('\\if')) { conditional++; continue; }
    const name = text.slice(tokens.lastIndex).match(/^\s*(?:\{(\\[A-Za-z@]+)\}|(\\[A-Za-z@]+))/);
    if (!name) continue;
    let pos = tokens.lastIndex + name[0].length;
    while (/\s/.test(text[pos] || '') && pos < text.length) pos++;
    let supported = depth === 0 && conditional === 0 && !['\\edef', '\\xdef', '\\let'].includes(token);
    if (text[pos] === '[') {
      const args = group(text, pos, '[', ']');
      supported &&= args.value.trim() === '0';
      pos = args.end;
      while (/\s/.test(text[pos] || '') && pos < text.length) pos++;
    }
    if (text[pos] !== '{') supported = false;
    const body = text[pos] === '{' ? group(text, pos, '{', '}') : null;
    if (body) tokens.lastIndex = body.end;
    if (token === '\\providecommand' && definitions.some(definition => definition.name === (name[1] || name[2]))) continue;
    if (definitions.length >= 128) throw new Error('Font-name macro scanning supports at most 128 simple command definitions.');
    definitions.push({ name: name[1] || name[2], value: body?.value.trim(), start: match.index, supported });
  }
  return (value, at) => {
    const resolve = (name, chain) => {
      const macro = name.trim();
      if (!/^\\[A-Za-z@]+$/.test(macro)) return macro;
      if (chain.length >= 8 || chain.includes(macro)) throw new Error('Font-name macros must be acyclic, with at most eight literal aliases.');
      const definition = definitions.findLast(definition => definition.name === macro && definition.start < at);
      if (!definition?.supported || definition.value === undefined)
        throw new Error(`Cannot resolve font-name macro ${macro}. Use an unconditional top-level \\newcommand or \\def with a literal name before the font declaration; arguments and computed definitions are unsupported.`);
      return resolve(definition.value, [...chain, macro]);
    };
    return resolve(value, []);
  };
}

function fontOptions(options, resolve, faces) {
  if (options.length > 512) throw new Error('Font options exceed the 512-character limit.');
  const features = [];
  const choices = {
    Ligatures: /^(?:TeX|NoTeX|Common|NoCommon|Required|NoRequired|Rare|NoRare|Discretionary|NoDiscretionary|Historic|NoHistoric)(?:\s*,\s*(?:TeX|NoTeX|Common|NoCommon|Required|NoRequired|Rare|NoRare|Discretionary|NoDiscretionary|Historic|NoHistoric))*$/,
    Numbers: /^(?:OldStyle|Lining|Proportional|Monospaced|SlashedZero|NoSlashedZero)(?:\s*,\s*(?:OldStyle|Lining|Proportional|Monospaced|SlashedZero|NoSlashedZero))*$/,
    Kerning: /^(?:On|Off)$/,
    Scale: /^(?:MatchLowercase|MatchUppercase|(?:\d+(?:\.\d*)?|\.\d+))$/,
    LetterSpace: /^-?(?:\d+(?:\.\d*)?|\.\d+)$/,
    Color: /^[A-Fa-f0-9]{6}(?:[A-Fa-f0-9]{2})?$/,
    Script: /^[A-Za-z ]{1,32}$/,
    Language: /^[A-Za-z ]{1,48}$/,
    Renderer: /^(?:OpenType|ICU)$/,
    Mapping: /^tex-text$/,
    RawFeature: /^[+-](?:kern|liga|clig)(?:\s*,\s*[+-](?:kern|liga|clig))*$/,
  };
  for (const option of options.split(/,(?![^{}]*\})/).filter(option => option.trim())) {
    const match = option.trim().match(/^([A-Za-z]+)\s*=\s*(?:\{([^{}]*)\}|([^{}]*))$/);
    if (!match) throw new Error('Font options must be simple key=value settings, with braced comma-separated values.');
    const [, key, braced, plain] = match;
    const value = (braced ?? plain).trim();
    if (['UprightFont', 'BoldFont', 'ItalicFont', 'BoldItalicFont'].includes(key) && faces) {
      if (!value && key !== 'UprightFont') faces[key] = null;
      else faces[key] = fontFace(resolve(value));
    } else if (key === 'Path' && faces?.UprightFont.virtualFile && value === 'fonts/') {
      // This is a virtual filename namespace, never a filesystem or network path.
      continue;
    } else {
      if (!choices[key]?.test(value) ||
          (key === 'Scale' && !value.startsWith('Match') && !(Number(value) >= 0.1 && Number(value) <= 10)) ||
          (key === 'LetterSpace' && !(Number(value) >= -5 && Number(value) <= 20)))
        throw new Error(`Unsupported fontspec option ${key}=${value}. Use face names or documented safe features; paths, URLs, computed features and external files are unsupported.`);
      features.push(`${key}={${value}}`);
    }
  }
  return features;
}

export function detectFonts(source) {
  if (typeof source !== 'string' || source.length > 100000) throw new Error('Compile a text document of at most 100,000 characters.');
  const text = fontSource(source);
  let macros;
  const resolve = (value, at) => {
    if (!value.includes('\\')) return value;
    macros ||= fontMacros(text);
    return macros(value, at);
  };
  const declarations = [];
  const regex = /\\(setmainfont|setsansfont|setmonofont|newfontfamily|fontspec|defaultfontfeatures|addfontfeatures|addfontfeature)\b/g;
  let match;
  while ((match = regex.exec(text))) {
    let pos = regex.lastIndex;
    const space = () => { while (/\s/.test(text[pos] || '') && pos < text.length) pos++; };
    space();
    if (['defaultfontfeatures', 'addfontfeatures', 'addfontfeature'].includes(match[1])) {
      if (text[pos] === '[') { pos = group(text, pos, '[', ']').end; space(); }
      const options = group(text, pos, '{', '}');
      fontOptions(options.value, value => resolve(value, match.index));
      regex.lastIndex = options.end;
      continue;
    }
    if (match[1] === 'newfontfamily') {
      const command = text.slice(pos).match(/^(?:\\[A-Za-z]+|\{\\[A-Za-z]+\})/);
      if (!command) throw new Error('Use \\newfontfamily\\name{Google Family}. Computed font commands are unsupported.');
      pos += command[0].length; space();
    }
    const prefix = text.slice(match.index, pos);
    let options = '';
    if (text[pos] === '[') { const value = group(text, pos, '[', ']'); options = value.value; pos = value.end; space(); }
    const family = group(text, pos, '{', '}');
    pos = family.end; space();
    let end = family.end;
    if (text[pos] === '[') {
      const trailing = group(text, pos, '[', ']');
      options += `${options ? ',' : ''}${trailing.value}`;
      end = trailing.end;
    }
    const upright = fontFace(resolve(family.value, match.index));
    const faces = { UprightFont: upright };
    const features = fontOptions(options, value => resolve(value, match.index), faces);
    declarations.push({ start: match.index, end, prefix, faces, features });
    regex.lastIndex = end;
  }
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
        if (globalThis.navigator?.locks) {
          await navigator.locks.request('google-tex-font-cache', { signal }, async () => {
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
          });
        } else console.warn('Persistent font caching requires Web Locks; bounded memory caching remains available.');
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
      if (upright.virtualFile) onStatus(`Resolving virtual ${upright.virtualFile} from Google Fonts; original binary/version is not available.`);
      if (bold && declaration.faces.BoldFont === undefined)
        declaration.faces.BoldFont = styled(upright, 700, upright.italic);
      if (italic && declaration.faces.ItalicFont === undefined) declaration.faces.ItalicFont = styled(upright, upright.weight, true);
      if (bold && italic && declaration.faces.BoldItalicFont === undefined) declaration.faces.BoldItalicFont = styled(upright, 700, true);
      for (const face of Object.values(declaration.faces)) if (face && !faces.has(face.key)) faces.set(face.key, face);
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
      const names = Object.entries(declaration.faces).filter(([style, face]) => style !== 'UprightFont' && face)
        .map(([style, face]) => `${style}=${faces.get(face.key).filename}`);
      // Explicit empty styles prevent fontspec's automatic system-font lookup/substitution.
      for (const style of ['BoldFont', 'ItalicFont', 'BoldItalicFont']) {
        if (!declaration.faces[style]) names.push(`${style}={}`);
      }
      const replacement = `${declaration.prefix}[${[...declaration.features, ...names].join(',')}]{${faces.get(declaration.faces.UprightFont.key).filename}}`;
      prepared = prepared.slice(0, declaration.start) + replacement + prepared.slice(declaration.end);
    }
    return { source: `\\tracinglostchars=2\n\\AtBeginDocument{\\tracinglostchars=2}\n${prepared}`, files };
  }
}
