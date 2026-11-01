import { useEffect, useRef } from 'react';
import './workspace-resize.css';

export const layoutKey = 'workspace-layout-v1';
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export function readLayout(text) {
  try {
    const value = JSON.parse(text);
    return {
      sidebar: Number.isFinite(value?.sidebar) ? clamp(value.sidebar, 180, 360) : null,
      split: Number.isFinite(value?.split) ? clamp(value.split, 0, 1) : .5,
    };
  } catch { return { sidebar: null, split: .5 }; }
}

export default function useWorkspaceResize(enabled) {
  const workspace = useRef(null);
  const panels = useRef(null);
  const sidebarHandle = useRef(null);
  const splitHandle = useRef(null);
  useEffect(() => {
    if (!enabled) return;
    const root = workspace.current, pair = panels.current;
    const handles = [sidebarHandle.current, splitHandle.current];
    const desktop = matchMedia('(min-width:1051px)');
    let preference = readLayout(null), drag = null, frame = 0;
    try { preference = readLayout(localStorage.getItem(layoutKey)); }
    catch (error) { console.warn('Workspace layout preferences could not be read.', error.name); }
    let sidebar = 208, source = 0, sidebarMax = 360, sourceMax = 0;
    const persist = () => {
      try { localStorage.setItem(layoutKey, JSON.stringify(preference)); }
      catch (error) { console.warn('Workspace layout preferences could not be saved.', error.name); }
    };
    const apply = () => {
      if (!desktop.matches) return;
      const gap = handles[0].getBoundingClientRect().width;
      sidebarMax = Math.min(360, root.clientWidth - 680 - gap * 2);
      sidebar = clamp(preference.sidebar ?? (innerWidth >= 1600 ? 220 : 208), 180, sidebarMax);
      root.style.setProperty('--sidebar-width', `${sidebar}px`);
      // Derive the remaining width immediately; the grid may not have laid out yet.
      const available = root.clientWidth - sidebar - gap * 2;
      sourceMax = available - 360;
      source = clamp(available * preference.split, 320, sourceMax);
      pair.style.setProperty('--source-width', `${source}px`);
      [sidebar, source].forEach((value, index) => {
        const handle = handles[index];
        handle.setAttribute('aria-valuemin', index ? '320' : '180');
        handle.setAttribute('aria-valuemax', String(Math.round(index ? sourceMax : sidebarMax)));
        handle.setAttribute('aria-valuenow', String(Math.round(value)));
        handle.setAttribute('aria-valuetext', `${Math.round(value)} pixels`);
      });
    };
    const setWidth = (index, value) => {
      if (index === 0) preference.sidebar = clamp(value, 180, sidebarMax);
      else {
        const available = sourceMax + 360;
        preference.split = clamp(clamp(value, 320, sourceMax) / available, 0, 1);
      }
      apply();
    };
    const finish = (cancel = false) => {
      if (!drag) return;
      cancelAnimationFrame(frame);
      frame = 0;
      const previous = drag;
      drag = null;
      if (cancel) preference = previous.preference;
      else if (previous.x !== null) setWidth(previous.index, previous.width + previous.x - previous.start);
      root.classList.remove('pane-dragging');
      if (previous.handle.hasPointerCapture(previous.id)) previous.handle.releasePointerCapture(previous.id);
      apply();
      if (!cancel) persist();
    };
    const move = event => {
      if (!drag || event.pointerId !== drag.id) return;
      drag.x = event.clientX;
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (drag) setWidth(drag.index, drag.width + drag.x - drag.start);
      });
    };
    const up = event => { if (event.pointerId === drag?.id) finish(); };
    const cancel = event => { if (event.pointerId === drag?.id) finish(true); };
    const listeners = handles.map((handle, index) => {
      const reset = () => {
        finish(true);
        if (index) preference.split = .5;
        else preference.sidebar = null;
        apply(); persist();
      };
      const down = event => {
        if (!desktop.matches || event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        finish(true);
        handle.focus();
        handle.setPointerCapture(event.pointerId);
        drag = { index, handle, id: event.pointerId, start: event.clientX, x: null,
          width: index ? source : sidebar, preference: { ...preference } };
        root.classList.add('pane-dragging');
      };
      const key = event => {
        if (!desktop.matches || event.ctrlKey || event.metaKey || event.altKey) return;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', 'Escape'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Escape') { finish(true); return; }
        if (event.key === 'Enter') { reset(); return; }
        finish(true);
        const width = index ? source : sidebar;
        const next = event.key === 'Home' ? (index ? 320 : 180)
          : event.key === 'End' ? (index ? sourceMax : sidebarMax)
          : width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 64 : 16);
        setWidth(index, next); persist();
      };
      const lost = () => finish(true);
      for (const [type, listener] of Object.entries({
        pointerdown: down, pointermove: move, pointerup: up, pointercancel: cancel,
        lostpointercapture: lost, keydown: key, dblclick: reset,
      })) handle.addEventListener(type, listener);
      return () => {
        for (const [type, listener] of Object.entries({
          pointerdown: down, pointermove: move, pointerup: up, pointercancel: cancel,
          lostpointercapture: lost, keydown: key, dblclick: reset,
        })) handle.removeEventListener(type, listener);
      };
    });
    const resize = () => { finish(true); apply(); };
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    desktop.addEventListener('change', resize);
    window.addEventListener('resize', resize);
    const blur = () => finish(true);
    window.addEventListener('blur', blur);
    apply();
    return () => {
      finish(true);
      observer.disconnect();
      desktop.removeEventListener('change', resize);
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', blur);
      listeners.forEach(remove => remove());
      cancelAnimationFrame(frame);
    };
  }, [enabled]);
  return { workspace, panels, sidebarHandle, splitHandle };
}
