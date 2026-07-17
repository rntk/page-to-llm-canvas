import { buildRecordViewIframeSrc } from './url.js';

// The record-view iframe is mutually exclusive with the in-page rail. Opening an
// iframe must close any open rail, but this module must not import the rail
// controllers (they import this one — that would be a cycle). main.jsx injects
// the rail closer instead.
let closeRail = () => {};

export function setRailCloser(fn) {
  closeRail = typeof fn === 'function' ? fn : () => {};
}

let canvasIframe = null;

export function getCanvasIframe() {
  return canvasIframe;
}

export function openRecordIframe(key, view) {
  removeCanvasIframe();
  closeRail();
  const iframe = document.createElement('iframe');
  iframe.id = 'pagetollm-canvas-iframe';
  iframe.src = buildRecordViewIframeSrc((path) => chrome.runtime.getURL(path), key, view);
  iframe.style.cssText =
    'position:fixed;inset:0;width:100vw;min-width:100vw;height:100vh;min-height:100vh;border:0;z-index:2147483647;';
  document.documentElement.appendChild(iframe);
  canvasIframe = iframe;
}

export function openCanvasIframe(key) {
  openRecordIframe(key);
}

export function openHierarchyIframe(key) {
  openRecordIframe(key, 'hierarchy');
}

export function removeCanvasIframe() {
  if (canvasIframe) {
    canvasIframe.remove();
    canvasIframe = null;
  }
  const existing = document.getElementById('pagetollm-canvas-iframe');
  if (existing) existing.remove();
}
