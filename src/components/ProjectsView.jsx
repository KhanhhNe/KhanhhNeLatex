import React, { useState } from 'react';
import './ProjectsView.css';
import Icon from './Icon.jsx';

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
    <div className="projects-shell">
      <aside className="projects-sidebar" aria-label="Workspace navigation">
        <a className="projects-brand" href="/" aria-label="KhanhhNeLatex home">k<span>KhanhhNeLatex</span></a>
        <nav><button className="projects-nav-current" aria-current="page" aria-label="Your projects"><Icon name="list" /><span>Your projects</span></button></nav>
        <div className="projects-account"><button onClick={onHelp} aria-label="Help" title="Help"><Icon name="help" /><span>Help</span></button>
          <button onClick={onSignIn} aria-label={username ? `Open workspace for ${username}` : 'Sign in'}><Icon name="user" /><span>{username || 'Sign in'}</span></button></div>
      </aside>
      <main className="projects-main">
        <header className="projects-toolbar">
          <h1>Your projects</h1>
          <label className="projects-search"><Icon name="search" /><input type="search" aria-label="Search projects" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <div className="projects-view" role="group" aria-label="Project view">
            <button aria-label="List view" aria-pressed={!grid} onClick={() => setGrid(false)}><Icon name="list" /></button>
            <button aria-label="Grid view" aria-pressed={grid} onClick={() => setGrid(true)}><Icon name="grid" /></button>
          </div>
          <button className="projects-import" onClick={onImport}><Icon name="upload" />Import .tex</button>
          <button className="projects-new" onClick={onNew}><Icon name="plus" />New document</button>
        </header>
        <div className="projects-columns">
          <button onClick={() => order('name')} aria-label={`Sort by name${sort === 'name' ? ascending ? ', ascending' : ', descending' : ''}`}>Name <span aria-hidden="true">{sort === 'name' ? ascending ? '↑' : '↓' : '↕'}</span></button>
          <button onClick={() => order('edited')} aria-label={`Sort by last edited${sort === 'edited' ? ascending ? ', ascending' : ', descending' : ''}`}>Last edited <span aria-hidden="true">{sort === 'edited' ? ascending ? '↑' : '↓' : '↕'}</span></button>
        </div>
        {projects.length ? <ul className={`projects-list ${grid ? 'projects-grid' : ''}`} aria-label="Projects">{projects.map(document =>
          <li key={document.id}><button className="projects-open" onClick={() => onOpen(document)}>
            <Icon name="file" className="projects-file" />
            <span className="projects-name">{document.title}<small>{document.cloudId ? 'Linked to account' : 'On this device'}</small></span>
            <time dateTime={new Date(document.updated_at).toISOString()}>{new Date(document.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>
          </button></li>)}</ul> : <div className="projects-empty">
          <h2>{query ? 'No matching documents' : 'Make room for your next idea'}</h2>
          <p>{query ? 'Try another name or start a new document.' : 'Begin with a local LaTeX document.'}</p>
          <button className="projects-new" onClick={onNew}>Start writing</button>
        </div>}
      </main>
    </div>
  </div>;
}
