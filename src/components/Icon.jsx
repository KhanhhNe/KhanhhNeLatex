import React from 'react';

const paths = {
  back: 'm14 7-5 5 5 5',
  panel: 'M4 5h16v14H4z M9 5v14',
  file: 'M6 3h8l4 4v14H6z M14 3v5h4',
  plus: 'M12 5v14 M5 12h14',
  upload: 'M12 16V4 m-5 5 5-5 5 5 M4 16v4h16v-4',
  download: 'M12 4v12 m-5-5 5 5 5-5 M4 17v3h16v-3',
  refresh: 'M19 8a8 8 0 1 0 1 7 M19 3v6h-6',
  close: 'm6 6 12 12 M6 18 18 6',
  help: 'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3 M12 17h.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  user: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2',
  search: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 m-2 5 6 6',
  list: 'M9 6h12 M9 12h12 M9 18h12 M3 6h1 M3 12h1 M3 18h1',
  grid: 'M3 3h6v6H3z M15 3h6v6h-6z M3 15h6v6H3z M15 15h6v6h-6z',
};

export default function Icon({ name, className = '' }) {
  return <svg className={`ui-icon ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={paths[name]} />
  </svg>;
}
