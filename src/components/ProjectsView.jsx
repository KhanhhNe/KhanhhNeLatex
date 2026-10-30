import React, { useState } from 'react';
import './ProjectsView.css';

export default function ProjectsView({ documents, onOpen, onNew, onImport, onSignIn, username, onHelp }) {
  const [query, setQuery] = useState('');
  const [grid, setGrid] = useState(false);
  const [sort, setSort] = useState('edited');
  const [ascending, setAscending] = useState(false);
  const projects = documents.filter(document => document.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => (sort === 'name' ? a.title.localeCompare(b.title) : a.updated_at - b.updated_at) * (ascending ? 1 : -1));
  function order(column) {
    if (sort === column) setAscending(value => !value);
    else { setSort(column); setAscending(column === 'name'); }
  }
  return <div className="projects-page">
    <div className="projects-notice"><span className="projects-notice-mark" aria-hidden="true">T<span>E</span>X</span>
      <p><strong>A workspace for your ideas.</strong> Text stays on this device until you link a document to your account.</p>
      <button onClick={onHelp}>About this workspace</button>
    </div>
    <div className="projects-shell">
      <aside className="projects-sidebar" aria-label="Workspace navigation">
        <a className="projects-brand" href="/" aria-label="KhanhhNeLatex home">k<span>KhanhhNeLatex</span></a>
        <nav><button className="projects-nav-current" aria-current="page" aria-label="Your projects"><span aria-hidden="true">▤</span> <span>Your projects</span></button></nav>
        <div className="projects-account"><button onClick={onSignIn} aria-label={username ? `Open workspace for ${username}` : 'Sign in'}><span aria-hidden="true">◉</span><span>{username || 'Sign in'}</span></button></div>
      </aside>
      <main className="projects-main">
        <header className="projects-toolbar">
          <h1>Your projects</h1>
          <label className="projects-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="Search projects" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <div className="projects-view" role="group" aria-label="Project view">
            <button aria-label="List view" aria-pressed={!grid} onClick={() => setGrid(false)}>☷</button>
            <button aria-label="Grid view" aria-pressed={grid} onClick={() => setGrid(true)}>▦</button>
          </div>
          <button className="projects-import" onClick={onImport}>Import .tex <span aria-hidden="true">⌄</span></button>
          <button className="projects-new" onClick={onNew}><span aria-hidden="true">＋</span> New document</button>
        </header>
        <div className="projects-columns">
          <button onClick={() => order('name')} aria-label={`Sort by name${sort === 'name' ? ascending ? ', ascending' : ', descending' : ''}`}>Name <span aria-hidden="true">{sort === 'name' ? ascending ? '↑' : '↓' : '↕'}</span></button>
          <button onClick={() => order('edited')} aria-label={`Sort by last edited${sort === 'edited' ? ascending ? ', ascending' : ', descending' : ''}`}>Last edited <span aria-hidden="true">{sort === 'edited' ? ascending ? '↑' : '↓' : '↕'}</span></button>
        </div>
        {projects.length ? <ul className={`projects-list ${grid ? 'projects-grid' : ''}`} aria-label="Projects">{projects.map(document =>
          <li key={document.id}><button className="projects-open" onClick={() => onOpen(document)}>
            <span className="projects-file" aria-hidden="true">T<span>E</span>X</span>
            <span className="projects-name">{document.title}<small>{document.cloudId ? 'Linked to account' : 'On this device'}</small></span>
            <time dateTime={new Date(document.updated_at).toISOString()}>{new Date(document.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>
          </button></li>)}</ul> : <div className="projects-empty">
          <h2>{query ? 'No matching documents' : 'Make room for your next idea'}</h2>
          <p>{query ? 'Try another name or start a new document.' : 'Begin with a local LaTeX document.'}</p>
          <button className="projects-new" onClick={onNew}>Start writing</button>
        </div>}
        <footer className="projects-footer">UTF-8 .tex documents only <span>Local drafts · Private browser compilation</span></footer>
      </main>
    </div>
  </div>;
}
