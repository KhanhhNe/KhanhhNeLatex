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
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  help: 'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3 M12 17h.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  user: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2',
  device: 'M6 3h12v18H6z M10 18h4',
  cloud: 'M7 18h10a4 4 0 0 0 .4-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9Z',
  search: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 m-2 5 6 6',
  list: 'M9 6h12 M9 12h12 M9 18h12 M3 6h1 M3 12h1 M3 18h1',
  grid: 'M3 3h6v6H3z M15 3h6v6h-6z M3 15h6v6H3z M15 15h6v6h-6z',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  terminal: 'M4 5h16v14H4z M8 10l3 2-3 2 M13 15h3',
  link: 'M10 13a5 5 0 0 0 7.07 0l3-3A5 5 0 0 0 13 2.93l-1.72 1.71 M14 11a5 5 0 0 0-7.07 0l-3 3A5 5 0 0 0 11 21.07l1.71-1.71',
  check: 'm5 12 4 4L19 6',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
};

export default function Icon({ name, className = '' }) {
  return <svg className={`ui-icon ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={paths[name]} />
  </svg>;
}
