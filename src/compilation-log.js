export const latexWarning = /^(?:(LaTeX)(?: Font)?|(?:Package|Class) (\S+)) Warning: (.*)$/;
export const boxWarning = /^(Overfull|Underfull) \\[hv]box /;
export const warningContinuation = /^\(\S+\)\s|^ {2,}\S/;

export function logLineKind(line) {
  if (line.startsWith('! ')) return 'error';
  if (latexWarning.test(line)) return 'warning';
  if (boxWarning.test(line)) return 'box';
  if (line.startsWith('Missing character:')) return 'font';
  return null;
}

// Keep original line endings and coalesce adjacent runs to bound the number of DOM nodes.
export function compilationLogRuns(text) {
  const runs = [];
  let context = null;
  for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const line = raw.replace(/\r?\n$/, '');
    const kind = logLineKind(line);
    let severity = kind === 'error' ? 'error' : kind ? 'warning' : null;
    if (!severity && context && (warningContinuation.test(line) ||
        (context === 'error' && /^(?:l\.\d+\s|<[^>]+>)/.test(line)))) severity = context;
    context = severity;
    const previous = runs.at(-1);
    if (previous?.severity === severity) previous.text += raw;
    else runs.push({ text: raw, severity });
  }
  return runs;
}
