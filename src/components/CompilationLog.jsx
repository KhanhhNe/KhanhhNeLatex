import React, { memo, useMemo } from 'react';
import { compilationLogRuns } from '../compilation-log.js';

export default memo(function CompilationLog({ text }) {
  const runs = useMemo(() => compilationLogRuns(text || 'No compilation log available.'), [text]);
  return <pre>{runs.map((run, index) => run.severity
    ? <span key={index} className={`log-${run.severity}`} title={run.severity === 'error' ? 'Error' : 'Warning'}>{run.text}</span>
    : run.text)}</pre>;
});
