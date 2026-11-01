import React, { useEffect, useRef, useState } from 'react';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import './PdfPreview.css';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const maxPixels = 2_000_000;
const maxPages = 3;
const settleDelay = 180;

export default function PdfPreview({ viewer, pending, onReady, onError, viewState }) {
  const root = useRef(null);
  const viewport = useRef(null);
  const sheet = useRef(null);
  const pages = useRef(null);
  const controls = useRef(null);
  const handlers = useRef(null);
  handlers.current = { pending, onReady, onError };
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const container = root.current, scroller = viewport.current;
    pages.current.replaceChildren();
    setError('');
    let disposed = false, failed = false, worker, pdfWorker, document, loading, renderTask, timer, loadTimer, frame = 0;
    let zoom = 1, paintedZoom = 1, width = 0, height = 0, fitted = true, ready = false, rendering = false;
    let generation = 0, gesture = null, saved, restored = false;
    const layout = [], cache = new Map(), pointers = new Map();
    const fail = reason => {
      if (disposed || failed || reason?.name === 'RenderingCancelledException') return;
      failed = true;
      clearTimeout(timer);
      clearTimeout(loadTimer);
      loading?.destroy().catch(error => console.warn('PDF preview cleanup failed.', error.name));
      pdfWorker?.destroy();
      worker?.terminate();
      setError(`PDF preview could not render: ${reason.message}. Export or open the PDF to view it.`);
      handlers.current.onError(reason);
    };
    const remember = () => {
      if (!handlers.current.pending && ready && scroller.clientWidth && scroller.clientHeight) viewState.current = {
        zoom, fitted, x: scroller.scrollLeft / zoom, y: scroller.scrollTop / zoom,
      };
    };
    const paint = () => {
      frame = 0;
      sheet.current.style.width = `${width * zoom}px`;
      sheet.current.style.height = `${height * zoom}px`;
      pages.current.style.transform = `scale(${zoom})`;
      paintedZoom = zoom;
      container.querySelector('output').textContent = `${Math.round(zoom * 100)}%`;
      remember();
    };
    const visible = () => {
      if (!scroller.clientHeight) {
        const index = layout.findIndex(page => page.y + page.height >= (saved?.y || 0));
        return layout.length ? [Math.max(0, index)] : [];
      }
      const top = scroller.scrollTop / zoom, bottom = top + scroller.clientHeight / zoom;
      const center = (top + bottom) / 2;
      return layout.map((page, index) => ({ index, distance: Math.abs(page.y + page.height / 2 - center),
        visible: page.y < bottom && page.y + page.height > top }))
        .filter(page => page.visible).sort((a, b) => a.distance - b.distance)
        .slice(0, maxPages).map(page => page.index);
    };
    const rasterize = async () => {
      if (disposed || failed || !document || gesture || pointers.size > 1 || rendering) return;
      rendering = true;
      const run = generation, wanted = visible();
      // Keep only viewport pages; no full-document canvas stack or per-event PDF work.
      for (const [index, record] of cache) {
        if (wanted.includes(index)) continue;
        record.canvas.remove();
        record.canvas.width = record.canvas.height = 0;
        cache.delete(index);
      }
      try {
        for (const index of wanted) {
          if (disposed || failed || run !== generation) break;
          const info = layout[index];
          const scale = Math.min(zoom * Math.min(devicePixelRatio || 1, 2),
            Math.sqrt(maxPixels / (info.width * info.height)));
          if (Math.abs((cache.get(index)?.scale || 0) - scale) < .01) continue;
          const page = await document.getPage(index + 1);
          if (disposed || failed || run !== generation) break;
          const canvas = window.document.createElement('canvas');
          const raster = page.getViewport({ scale });
          canvas.width = Math.max(1, Math.floor(raster.width));
          canvas.height = Math.max(1, Math.floor(raster.height));
          canvas.setAttribute('aria-label', `PDF page ${index + 1}`);
          renderTask = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }),
            viewport: raster, background: '#ffffff' });
          try { await renderTask.promise; }
          catch (reason) { canvas.width = canvas.height = 0; throw reason; }
          finally { renderTask = null; }
          if (disposed || failed || run !== generation) {
            canvas.width = canvas.height = 0;
            break;
          }
          const previous = cache.get(index)?.canvas;
          info.element.replaceChildren(canvas);
          if (previous) previous.width = previous.height = 0;
          cache.set(index, { canvas, scale });
          page.cleanup();
        }
        if (!ready && !disposed && run === generation && wanted.length && wanted.every(index => cache.has(index))) {
          ready = true;
          clearTimeout(loadTimer);
          container.dispatchEvent(new CustomEvent('load', { detail: 'pdf-rendered' }));
          remember();
        }
      } catch (reason) { fail(reason); }
      finally {
        rendering = false;
        if (!disposed && (run !== generation || visible().some(index => !cache.has(index)))) schedule();
      }
    };
    const schedule = () => {
      if (failed || disposed) return;
      clearTimeout(timer);
      timer = setTimeout(rasterize, settleDelay);
    };
    const changeZoom = (next, x = scroller.clientWidth / 2, y = scroller.clientHeight / 2) => {
      next = clamp(next, .25, 4);
      if (!width || next === zoom) return;
      const anchorX = (scroller.scrollLeft + x - sheet.current.offsetLeft) / paintedZoom;
      const anchorY = (scroller.scrollTop + y - sheet.current.offsetTop) / paintedZoom;
      fitted = false;
      zoom = next;
      generation++;
      renderTask?.cancel();
      // One geometry update per animation frame; the existing raster stays on screen.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        paint();
        scroller.scrollLeft = anchorX * zoom + sheet.current.offsetLeft - x;
        scroller.scrollTop = anchorY * zoom + sheet.current.offsetTop - y;
        remember();
      });
      schedule();
    };
    const wheel = event => {
      if (!event.ctrlKey || !width) return;
      event.preventDefault();
      const box = scroller.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1);
      changeZoom(zoom * Math.exp(-clamp(delta, -100, 100) * .01),
        event.clientX - box.left, event.clientY - box.top);
    };
    const gestureStart = event => {
      if (!width) return;
      event.preventDefault();
      if (pointers.size) return;
      gesture = { native: true, zoom };
      generation++;
      renderTask?.cancel();
      clearTimeout(timer);
    };
    const gestureChange = event => {
      if (!gesture?.native) return;
      event.preventDefault();
      const box = scroller.getBoundingClientRect();
      changeZoom(gesture.zoom * event.scale, event.clientX - box.left, event.clientY - box.top);
    };
    const gestureEnd = event => {
      if (!gesture?.native) return;
      event.preventDefault();
      gesture = null;
      schedule();
    };
    const pair = () => {
      const [a, b] = [...pointers.values()];
      return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };
    const down = event => {
      if (event.pointerType !== 'touch' || !width) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      scroller.setPointerCapture(event.pointerId);
      if (pointers.size === 2) {
        cancelAnimationFrame(frame);
        paint();
        const center = pair(), box = scroller.getBoundingClientRect();
        gesture = { ...center, zoom, anchorX: (scroller.scrollLeft + center.x - box.left - sheet.current.offsetLeft) / zoom,
          anchorY: (scroller.scrollTop + center.y - box.top - sheet.current.offsetTop) / zoom };
        generation++;
        renderTask?.cancel();
        clearTimeout(timer);
      } else if (pointers.size === 1) gesture = { pan: true, x: event.clientX, y: event.clientY };
    };
    const move = event => {
      if (!pointers.has(event.pointerId)) return;
      event.preventDefault();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size >= 2 && gesture && !gesture.pan) {
        const center = pair();
        zoom = clamp(gesture.zoom * center.distance / gesture.distance, .25, 4);
        fitted = false;
        if (!frame) frame = requestAnimationFrame(() => {
          paint();
          const center = pair(), box = scroller.getBoundingClientRect();
          scroller.scrollLeft = gesture.anchorX * zoom + sheet.current.offsetLeft - (center.x - box.left);
          scroller.scrollTop = gesture.anchorY * zoom + sheet.current.offsetTop - (center.y - box.top);
          remember();
        });
      } else if (gesture?.pan) {
        scroller.scrollLeft += gesture.x - event.clientX;
        scroller.scrollTop += gesture.y - event.clientY;
        gesture = { pan: true, x: event.clientX, y: event.clientY };
        remember();
      }
    };
    const up = event => {
      if (!pointers.has(event.pointerId)) return;
      cancelAnimationFrame(frame);
      paint();
      if (gesture && !gesture.pan && pointers.size >= 2) {
        const center = pair(), box = scroller.getBoundingClientRect();
        scroller.scrollLeft = gesture.anchorX * zoom + sheet.current.offsetLeft - (center.x - box.left);
        scroller.scrollTop = gesture.anchorY * zoom + sheet.current.offsetTop - (center.y - box.top);
      }
      pointers.delete(event.pointerId);
      if (scroller.hasPointerCapture(event.pointerId)) scroller.releasePointerCapture(event.pointerId);
      gesture = null;
      if (pointers.size === 1) {
        const remaining = [...pointers.values()][0];
        gesture = { pan: true, ...remaining };
      }
      schedule();
    };
    const fit = () => {
      if (!width || !scroller.clientWidth) return;
      changeZoom(Math.min(1, (scroller.clientWidth - 16) / width), 0, 0);
      fitted = true;
      remember();
    };
    const key = event => {
      if (!(event.ctrlKey || event.metaKey) || !['+', '=', '-', '0'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === '0') fit();
      else changeZoom(zoom * (event.key === '-' ? 1 / 1.2 : 1.2));
    };
    const scroll = () => { remember(); schedule(); };
    const loaded = () => handlers.current.onReady();
    container.addEventListener('load', loaded);
    scroller.addEventListener('wheel', wheel, { passive: false });
    scroller.addEventListener('gesturestart', gestureStart, { passive: false });
    scroller.addEventListener('gesturechange', gestureChange, { passive: false });
    scroller.addEventListener('gestureend', gestureEnd, { passive: false });
    scroller.addEventListener('pointerdown', down);
    scroller.addEventListener('pointermove', move, { passive: false });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) scroller.addEventListener(type, up);
    scroller.addEventListener('scroll', scroll, { passive: true });
    scroller.addEventListener('keydown', key);
    controls.current = { in: () => changeZoom(zoom * 1.2), out: () => changeZoom(zoom / 1.2), fit };
    const restore = () => {
      if (!width || !scroller.clientWidth) return;
      if (fitted) zoom = clamp(Math.min(1, (scroller.clientWidth - 16) / width), .25, 4);
      paint();
      if (saved) {
        scroller.scrollLeft = saved.x * zoom;
        scroller.scrollTop = saved.y * zoom;
      }
      restored = true;
      remember();
    };
    const observer = new ResizeObserver(() => {
      if (!restored) restore();
      else if (fitted) fit();
      schedule();
    });
    observer.observe(scroller);
    loadTimer = setTimeout(() => fail(new Error('PDF preview loading timed out')), 15000);
    (async () => {
      const pdfjs = await import('pdfjs-dist');
      if (disposed || failed) return;
      worker = new Worker(workerUrl, { type: 'module' });
      pdfWorker = new pdfjs.PDFWorker({ port: worker });
      loading = pdfjs.getDocument({
        data: new Uint8Array(viewer.bytes).slice(), worker: pdfWorker,
        cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/',
        wasmUrl: '/pdfjs/wasm/', isEvalSupported: false, useSystemFonts: false,
      });
      document = await loading.promise;
      if (disposed || failed) { await document.destroy(); return; }
      if (document.numPages > 1000) throw new Error('Preview is limited to 1,000 pages');
      for (let index = 0; index < document.numPages; index++) {
        const page = await document.getPage(index + 1);
        if (disposed || failed) return;
        const base = page.getViewport({ scale: 1 });
        const element = window.document.createElement('div');
        element.className = 'pdf-page';
        element.style.cssText = `top:${height}px;width:${base.width}px;height:${base.height}px`;
        element.setAttribute('role', 'img');
        element.setAttribute('aria-label', `PDF page ${index + 1}. Open PDF for selectable text.`);
        pages.current.append(element);
        layout.push({ element, y: height, width: base.width, height: base.height });
        width = Math.max(width, base.width);
        height += base.height + 12;
        page.cleanup();
      }
      pages.current.style.width = `${width}px`;
      pages.current.style.height = `${height}px`;
      saved = viewState.current;
      fitted = saved?.fitted ?? true;
      zoom = saved?.zoom || 1;
      paint();
      restore();
      await rasterize();
    })().catch(fail);
    return () => {
      disposed = true;
      generation++;
      clearTimeout(timer);
      clearTimeout(loadTimer);
      cancelAnimationFrame(frame);
      renderTask?.cancel();
      observer.disconnect();
      container.removeEventListener('load', loaded);
      scroller.removeEventListener('wheel', wheel);
      scroller.removeEventListener('gesturestart', gestureStart);
      scroller.removeEventListener('gesturechange', gestureChange);
      scroller.removeEventListener('gestureend', gestureEnd);
      scroller.removeEventListener('pointerdown', down);
      scroller.removeEventListener('pointermove', move);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) scroller.removeEventListener(type, up);
      scroller.removeEventListener('scroll', scroll);
      scroller.removeEventListener('keydown', key);
      for (const record of cache.values()) record.canvas.width = record.canvas.height = 0;
      loading?.destroy().catch(reason => console.warn('PDF preview cleanup failed.', reason.name));
      pdfWorker?.destroy();
      worker?.terminate();
    };
  }, [viewer.url, attempt]);
  return <div ref={root} data-src={viewer.url} title={pending ? 'Loading compiled PDF' : 'Compiled PDF'}
    className={`pdf-viewer${pending ? ` pending${viewer.ready ? ' ready' : ''}` : ''}`}
    aria-hidden={pending ? true : undefined}>
    <div className="pdf-zoom-toolbar" role="group" aria-label="PDF zoom">
      <button aria-label="Zoom out" disabled={pending} onClick={() => controls.current?.out()}>-</button>
      <output aria-label="PDF zoom level">100%</output>
      <button aria-label="Zoom in" disabled={pending} onClick={() => controls.current?.in()}>+</button>
      <button disabled={pending} onClick={() => controls.current?.fit()}>Fit width</button>
      <a href={viewer.url} target="_blank" rel="noopener" tabIndex={pending ? -1 : 0}>Open PDF</a>
    </div>
    {error && <div className="pdf-render-error" role="alert">{error}
      <button onClick={() => setAttempt(value => value + 1)}>Retry preview</button></div>}
    <div ref={viewport} className="pdf-viewport" tabIndex={pending ? -1 : 0}
      role="region" aria-label="PDF pages. Pinch to zoom; use Open PDF for selectable text.">
      <div ref={sheet} className="pdf-sheet"><div ref={pages} className="pdf-pages" /></div>
    </div>
  </div>;
}
