import React, { useEffect, useRef, useState } from 'react';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import './PdfPreview.css';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lowMemory = typeof navigator !== 'undefined' && (navigator.deviceMemory || 4) <= 2;
// Whole-page canvases up to this size; larger zooms use a low-res backdrop plus a viewport-sized sharp tile.
const pageCap = lowMemory ? 3_000_000 : 6_000_000;
const backdropCap = 1_000_000;
const detailCap = lowMemory ? 6_000_000 : 12_000_000;
const maxPages = 3;
const settleDelay = 180;
// Momentum wheel events arrive every frame; a longer gap ends the inertial tail.
const wheelTailGap = 80;
const scrollIdle = 150;
const ratio = () => clamp(window.devicePixelRatio || 1, .25, 4);
const area = box => (box.x1 - box.x0) * (box.y1 - box.y0);
const release = canvas => {
  if (!canvas) return;
  canvas.remove();
  canvas.width = canvas.height = 0;
};

export default function PdfPreview({ viewer, pending, onReady, onError, onPageChange, viewState }) {
  const sync = useRef(null);
  const root = useRef(null);
  const viewport = useRef(null);
  const sheet = useRef(null);
  const pages = useRef(null);
  const controls = useRef(null);
  const handlers = useRef(null);
  handlers.current = { pending, onReady, onError, onPageChange };
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const container = root.current, scroller = viewport.current;
    pages.current.replaceChildren();
    setError('');
    let disposed = false, failed = false, worker, pdfWorker, document, loading, renderTask, timer, loadTimer, frame = 0;
    let zoom = 1, paintedZoom = 1, width = 0, height = 0, fitted = true, ready = false, rendering = false;
    let generation = 0, gesture = null, pinch = null, saved, restored = false, revealTimer;
    let lastWheel = -Infinity, wheelZoom = false, dirty = false, dprQuery;
    // Pages are laid out in real CSS pixels at layoutZoom; transforms only bridge an unsettled zoom.
    let layoutZoom = 1, layoutDpr = 0;
    let reportedPage = 0;
    const layout = [], cache = new Map();
    const zooming = () => Boolean(pinch || gesture);
    const fail = reason => {
      if (disposed || failed || reason?.name === 'RenderingCancelledException') return;
      failed = true;
      clearTimeout(timer);
      clearTimeout(loadTimer);
      clearTimeout(revealTimer);
      loading?.destroy().catch(error => console.warn('PDF preview cleanup failed.', error.name));
      pdfWorker?.destroy();
      worker?.terminate();
      setError(`PDF preview could not render: ${reason.message}. Export or open the PDF to view it.`);
      if (!handlers.current.pending) handlers.current.onPageChange?.(null);
      handlers.current.onError(reason);
    };
    const remember = () => {
      if (!handlers.current.pending && ready && scroller.clientWidth && scroller.clientHeight) viewState.current = {
        zoom, fitted, x: scroller.scrollLeft / zoom, y: scroller.scrollTop / zoom, at: performance.now(),
      };
    };
    const paint = () => {
      frame = 0;
      sheet.current.style.width = `${width * zoom}px`;
      sheet.current.style.height = `${height * zoom}px`;
      pages.current.style.transform = zoom === layoutZoom ? 'none' : `scale(${zoom / layoutZoom})`;
      pages.current.dataset.zoom = zoom;
      paintedZoom = zoom;
      container.querySelector('output').textContent = `${Math.round(zoom * 100)}%`;
      remember();
    };
    const visible = () => {
      if (!scroller.clientHeight) {
        const index = layout.findIndex(page => page.y + page.height >= (saved?.y || 0));
        return layout.length ? [Math.max(0, index)] : [];
      }
      const top = (scroller.scrollTop - sheet.current.offsetTop) / zoom, bottom = top + scroller.clientHeight / zoom;
      const left = (scroller.scrollLeft - sheet.current.offsetLeft) / zoom, right = left + scroller.clientWidth / zoom;
      const center = (top + bottom) / 2;
      const ranked = [];
      for (let index = 0; index < layout.length; index++) {
        const page = layout[index];
        if (page.y >= bottom) break;
        if (page.y + page.height <= top) continue;
        const across = Math.max(0, Math.min(page.width, right) - Math.max(0, left));
        const down = Math.max(0, Math.min(page.y + page.height, bottom) - Math.max(page.y, top));
        if (across > 0 && down > 0)
          ranked.push({ index, across, area: across * down, distance: Math.abs(page.y + page.height / 2 - center) });
      }
      ranked.sort((a, b) => b.area - a.area || a.distance - b.distance);
      // Keep the current page at near-equal boundaries instead of flickering on fractional scroll pixels.
      const previous = ranked.find(page => page.index + 1 === reportedPage);
      if (previous && ranked[0].area - previous.area <= 2 * ranked[0].across / zoom) {
        ranked.splice(ranked.indexOf(previous), 1);
        ranked.unshift(previous);
      }
      return ranked.slice(0, maxPages).map(page => page.index);
    };
    const reportPage = (index = visible()[0]) => {
      if (!ready || failed || disposed || handlers.current.pending || !scroller.clientWidth || !scroller.clientHeight ||
        index === undefined || index + 1 === reportedPage) return;
      reportedPage = index + 1;
      handlers.current.onPageChange?.({ page: reportedPage, total: document.numPages });
    };
    const relayout = () => {
      const dpr = ratio();
      if (layoutZoom !== zoom || layoutDpr !== dpr) {
        // Snap every page box to whole device pixels so its canvas maps 1:1 without resampling.
        const snap = value => Math.round(value * zoom * dpr);
        for (const info of layout) {
          info.top = snap(info.y);
          info.dw = Math.max(1, snap(info.width));
          info.dh = Math.max(1, snap(info.height));
          info.element.style.top = `${info.top / dpr}px`;
          info.element.style.width = `${info.dw / dpr}px`;
          info.element.style.height = `${info.dh / dpr}px`;
        }
        pages.current.style.width = `${width * zoom}px`;
        pages.current.style.height = `${height * zoom}px`;
        layoutZoom = zoom;
        layoutDpr = dpr;
        paint();
      }
      // Centering and split panes can leave the sheet on a fractional device pixel; cancel that offset.
      const node = pages.current, box = node.getBoundingClientRect();
      const nudgeX = Number.parseFloat(node.style.left) || 0, nudgeY = Number.parseFloat(node.style.top) || 0;
      const x = box.left - nudgeX, y = box.top - nudgeY;
      node.style.left = `${Math.round(x * dpr) / dpr - x}px`;
      node.style.top = `${Math.round(y * dpr) / dpr - y}px`;
    };
    const region = (info, extra) => {
      const box = info.element.getBoundingClientRect(), view = scroller.getBoundingClientRect();
      const left = view.left + scroller.clientLeft, top = view.top + scroller.clientTop;
      const mx = scroller.clientWidth * extra, my = scroller.clientHeight * extra;
      return {
        x0: clamp(Math.floor((left - mx - box.left) * layoutDpr), 0, info.dw),
        x1: clamp(Math.ceil((left + scroller.clientWidth + mx - box.left) * layoutDpr), 0, info.dw),
        y0: clamp(Math.floor((top - my - box.top) * layoutDpr), 0, info.dh),
        y1: clamp(Math.ceil((top + scroller.clientHeight + my - box.top) * layoutDpr), 0, info.dh),
      };
    };
    const draw = async (page, canvas, scale, offsetX = 0, offsetY = 0) => {
      renderTask = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport: page.getViewport({ scale, offsetX, offsetY }), background: '#ffffff' });
      try { await renderTask.promise; }
      catch (reason) { canvas.width = canvas.height = 0; throw reason; }
      finally { renderTask = null; }
    };
    const rasterize = async () => {
      if (disposed || failed || !document || zooming()) return;
      if (rendering) { dirty = true; return; }
      rendering = true;
      dirty = false;
      relayout();
      const run = generation, wanted = visible(), stale = () => disposed || failed || run !== generation;
      reportPage(wanted[0]);
      // Keep only viewport pages; no full-document canvas stack or per-event PDF work.
      for (const [index, record] of cache) {
        if (wanted.includes(index)) continue;
        release(record.canvas);
        release(record.detail?.canvas);
        cache.delete(index);
      }
      try {
        for (const index of wanted) {
          if (stale()) break;
          const info = layout[index], record = cache.get(index) ?? {};
          const whole = info.dw * info.dh <= pageCap, key = `${whole ? 'page' : 'backdrop'}:${info.dw}x${info.dh}`;
          let page;
          if (record.key !== key) {
            page = await document.getPage(index + 1);
            if (stale()) break;
            const shrink = whole ? 1 : Math.sqrt(backdropCap / (info.dw * info.dh));
            const canvas = window.document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(info.dw * shrink));
            canvas.height = Math.max(1, Math.round(info.dh * shrink));
            canvas.setAttribute('aria-label', `PDF page ${index + 1}`);
            await draw(page, canvas, canvas.width / info.width);
            if (stale()) { canvas.width = canvas.height = 0; break; }
            release(record.canvas);
            if (whole) { release(record.detail?.canvas); record.detail = null; }
            info.element.prepend(canvas);
            Object.assign(record, { canvas, key });
            cache.set(index, record);
          }
          if (!whole) {
            const view = region(info, 0), detail = record.detail;
            const covered = detail?.key === key && detail.x0 <= view.x0 && detail.y0 <= view.y0 &&
              detail.x1 >= view.x1 && detail.y1 >= view.y1;
            let want = region(info, .125);
            if (area(want) > detailCap) want = view;
            if (area(view) > 0 && !covered && area(want) <= detailCap) {
              page ??= await document.getPage(index + 1);
              if (stale()) break;
              const canvas = window.document.createElement('canvas');
              canvas.className = 'pdf-detail';
              canvas.width = want.x1 - want.x0;
              canvas.height = want.y1 - want.y0;
              canvas.setAttribute('aria-hidden', 'true');
              Object.assign(canvas.style, { left: `${want.x0 / info.dw * 100}%`, top: `${want.y0 / info.dh * 100}%`,
                width: `${canvas.width / info.dw * 100}%`, height: `${canvas.height / info.dh * 100}%` });
              await draw(page, canvas, info.dw / info.width, -want.x0, -want.y0);
              if (stale()) { canvas.width = canvas.height = 0; break; }
              release(detail?.canvas);
              info.element.append(canvas);
              record.detail = { canvas, key, ...want };
            }
          }
          page?.cleanup();
        }
        if (!ready && !disposed && run === generation && wanted.length && wanted.every(index => cache.has(index))) {
          clearTimeout(loadTimer);
          reveal();
        }
      } catch (reason) { fail(reason); }
      finally {
        rendering = false;
        if (!disposed && (dirty || run !== generation || visible().some(index => !cache.has(index)))) schedule();
      }
    };    const schedule = () => {
      if (failed || disposed) return;
      clearTimeout(timer);
      timer = setTimeout(() => { timer = 0; rasterize(); }, settleDelay);
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
        reportPage();
      });
      schedule();
    };
    // Zoom only on real zoom gestures. Plain wheel/touch scrolling is never prevented, so the
    // browser's native, compositor-driven momentum (iOS, macOS trackpads, precision touchpads) stays intact.
    const wheel = event => {
      const now = event.timeStamp, tail = now - lastWheel < wheelTailGap && !wheelZoom;
      lastWheel = now;
      if (!(event.ctrlKey || event.metaKey) || !width) { wheelZoom = false; return; }
      event.preventDefault();
      if (gesture || pinch) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
      if (tail) {
        // A modifier pressed during an inertial scroll tail must not turn momentum into zoom.
        scroller.scrollBy(event.deltaX * unit, event.deltaY * unit);
        return;
      }
      wheelZoom = true;
      const box = scroller.getBoundingClientRect();
      const delta = event.deltaY * unit;
      changeZoom(zoom * Math.exp(-clamp(delta, -100, 100) * .01),
        event.clientX - box.left, event.clientY - box.top);
    };
    const gestureStart = event => {
      if (event.cancelable) event.preventDefault();
      if (!width || pinch) return;
      gesture = { zoom };
      generation++;
      renderTask?.cancel();
      clearTimeout(timer);
    };
    const gestureChange = event => {
      if (event.cancelable) event.preventDefault();
      if (!gesture || pinch) return;
      const box = scroller.getBoundingClientRect();
      changeZoom(gesture.zoom * event.scale, event.clientX - box.left, event.clientY - box.top);
    };
    const gestureEnd = event => {
      if (event.cancelable) event.preventDefault();
      if (!gesture) return;
      gesture = null;
      schedule();
    };
    const pair = event => {
      const [a, b] = event.touches;
      return { distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
        x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    };
    const startPinch = event => {
      cancelAnimationFrame(frame);
      paint();
      const center = pair(event), box = scroller.getBoundingClientRect();
      pinch = { ...center, zoom, anchorX: (scroller.scrollLeft + center.x - box.left - sheet.current.offsetLeft) / zoom,
        anchorY: (scroller.scrollTop + center.y - box.top - sheet.current.offsetTop) / zoom };
      gesture = null;
      generation++;
      renderTask?.cancel();
      clearTimeout(timer);
    };
    const place = () => {
      const box = scroller.getBoundingClientRect();
      scroller.scrollLeft = pinch.anchorX * zoom + sheet.current.offsetLeft - (pinch.x - box.left);
      scroller.scrollTop = pinch.anchorY * zoom + sheet.current.offsetTop - (pinch.y - box.top);
    };
    // Passive: one-finger pans and flings stay native; only a second finger starts a pinch.
    const touchStart = event => {
      if (event.touches.length === 2 && width && !pinch) startPinch(event);
    };
    // Cancels only two-finger movement. Once the browser has begun a native pan it marks
    // touchmove uncancelable; the pinch then yields instead of fighting the scroll.
    const touchMove = event => {
      if (event.touches.length < 2 || !width) return;
      if (!event.cancelable) {
        if (pinch) { pinch = null; schedule(); }
        return;
      }
      event.preventDefault();
      if (!pinch) startPinch(event);
      const center = pair(event);
      zoom = clamp(pinch.zoom * center.distance / pinch.distance, .25, 4);
      pinch.x = center.x;
      pinch.y = center.y;
      fitted = false;
      if (!frame) frame = requestAnimationFrame(() => {
        paint();
        if (pinch) place();
        remember();
        reportPage();
      });
    };
    const touchEnd = event => {
      if (!pinch || event.touches.length >= 2) return;
      cancelAnimationFrame(frame);
      paint();
      place();
      remember();
      reportPage();
      pinch = null;
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
    const scroll = () => {
      remember();
      reportPage();
      if (failed || disposed || zooming() || timer) return;
      // Scroll is throttled, not debounced: newly visible pages fill during a long pan.
      timer = setTimeout(() => { timer = 0; rasterize(); }, settleDelay);
    };
    const loaded = () => handlers.current.onReady({ pages: document?.numPages ?? null });
    container.addEventListener('load', loaded);
    scroller.addEventListener('wheel', wheel, { passive: false });
    scroller.addEventListener('gesturestart', gestureStart, { passive: false });
    scroller.addEventListener('gesturechange', gestureChange, { passive: false });
    scroller.addEventListener('gestureend', gestureEnd, { passive: false });
    scroller.addEventListener('touchstart', touchStart, { passive: true });
    scroller.addEventListener('touchmove', touchMove, { passive: false });
    for (const type of ['touchend', 'touchcancel']) scroller.addEventListener(type, touchEnd, { passive: true });
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
      reportPage();
    };
    // A replacement PDF adopts the shown preview's latest position, not the one from when it began loading.
    const drifted = () => {
      const latest = viewState.current;
      if (!latest || !restored || !scroller.clientWidth) return false;
      if (latest.fitted !== fitted || (!latest.fitted && Math.abs(latest.zoom - zoom) > .001)) return true;
      // Shorter replacements cannot reach a position beyond their final page.
      const x = clamp(latest.x * zoom, 0, scroller.scrollWidth - scroller.clientWidth);
      const y = clamp(latest.y * zoom, 0, scroller.scrollHeight - scroller.clientHeight);
      return Math.abs(x - scroller.scrollLeft) > 1 || Math.abs(y - scroller.scrollTop) > 1;
    };
    const adopt = () => {
      saved = viewState.current;
      fitted = saved.fitted ?? true;
      zoom = saved.zoom || zoom;
      generation++;
      renderTask?.cancel();
      restore();
    };
    // Never swap a replacement in while the shown preview is still scrolling (including momentum):
    // wait for scroll idle, then catch up to its final position before revealing.
    const reveal = () => {
      clearTimeout(revealTimer);
      if (disposed || failed || ready) return;
      if (handlers.current.pending) {
        const busy = scrollIdle - (performance.now() - (viewState.current?.at ?? -Infinity));
        if (busy > 0) { revealTimer = setTimeout(reveal, busy); return; }
        if (drifted()) { adopt(); schedule(); return; }
      }
      ready = true;
      container.dispatchEvent(new CustomEvent('load', { detail: 'pdf-rendered' }));
      remember();
      reportPage();
    };
    sync.current = () => {
      if (ready && !disposed && !failed && drifted()) { adopt(); schedule(); }
      reportPage();
    };
    const observer = new ResizeObserver(() => {
      if (!restored) restore();
      else if (fitted) fit();
      if (!frame) reportPage();
      schedule();
    });
    observer.observe(scroller);
    const dprChanged = () => {
      dprQuery?.removeEventListener('change', dprChanged);
      dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprQuery.addEventListener('change', dprChanged);
      if (!document) return;
      generation++;
      renderTask?.cancel();
      schedule();
    };
    dprChanged();
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
      clearTimeout(revealTimer);
      sync.current = null;
      cancelAnimationFrame(frame);
      renderTask?.cancel();
      observer.disconnect();
      dprQuery?.removeEventListener('change', dprChanged);
      container.removeEventListener('load', loaded);
      scroller.removeEventListener('wheel', wheel);
      scroller.removeEventListener('gesturestart', gestureStart);
      scroller.removeEventListener('gesturechange', gestureChange);
      scroller.removeEventListener('gestureend', gestureEnd);
      scroller.removeEventListener('touchstart', touchStart);
      scroller.removeEventListener('touchmove', touchMove);
      for (const type of ['touchend', 'touchcancel']) scroller.removeEventListener(type, touchEnd);
      scroller.removeEventListener('scroll', scroll);
      scroller.removeEventListener('keydown', key);
      for (const record of cache.values()) { release(record.canvas); release(record.detail?.canvas); }
      loading?.destroy().catch(reason => console.warn('PDF preview cleanup failed.', reason.name));
      pdfWorker?.destroy();
      worker?.terminate();
    };
  }, [viewer.url, attempt]);
  // The shown preview may have scrolled during the replacement's fade-in.
  useEffect(() => { if (!pending) sync.current?.(); }, [pending]);
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
