export function parseModalRoute(search) {
  try {
    const params = new URLSearchParams(search || '');
    return { key: params.get('key') || '', view: params.get('view') || '' };
  } catch (_) {
    return { key: '', view: '' };
  }
}
