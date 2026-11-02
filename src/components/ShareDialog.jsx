import React, { useEffect, useRef, useState } from 'react';
import './sharing.css';

export default function ShareDialog({ createShare, onClose, signedIn, onSignIn }) {
  const dialog = useRef(null);
  const [link, setLink] = useState('');
  const [status, setStatus] = useState(signedIn ? 'Saving the latest document and preparing its link...' : '');
  const [error, setError] = useState('');
  async function copy(value = link) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('Link copied to clipboard.');
    } catch {
      setStatus('Clipboard access is unavailable. Use Copy link or select and copy the link below.');
    }
  }
  useEffect(() => {
    dialog.current.showModal();
    let disposed = false;
    if (signedIn) createShare().then(id => {
      if (disposed) return;
      const url = `${location.origin}/share/${id}`;
      setLink(url);
      copy(url);
    }).catch(reason => { if (!disposed) { setError(reason.message); setStatus(''); } });
    return () => { disposed = true; };
  }, []);
  return <dialog ref={dialog} className="modal share-dialog" aria-labelledby="share-title" onClose={onClose}>
    <h2 id="share-title">Share read-only link</h2>
    <p>Anyone with this link can view the latest account version, read its LaTeX source and export it without an account. They cannot edit your document.</p>
    {!signedIn ? <>
      <p>Sign in first to save this document to your account and create a share link. Device-only drafts cannot be shared.</p>
      <button className="account" onClick={() => { onClose(); onSignIn(); }}>Sign in to share</button>
    </> : <>
      {link && <label>Share link<input aria-label="Share link" value={link} readOnly onFocus={event => event.target.select()} /></label>}
      <p role="status">{status}</p>
      {error && <p role="alert">{error}</p>}
      <button className="compile-button" disabled={!link} onClick={() => copy()}>Copy link</button>
    </>}
    <button className="quiet" autoFocus onClick={() => dialog.current.close()}>Close</button>
  </dialog>;
}
