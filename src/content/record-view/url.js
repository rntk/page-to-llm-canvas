export function buildRecordViewIframeSrc(getUrl, key, view) {
  const base = getUrl('modal.html');
  const params = [`key=${encodeURIComponent(key)}`];
  if (view && view !== 'canvas') {
    params.push(`view=${encodeURIComponent(view)}`);
  }
  return `${base}?${params.join('&')}`;
}
