function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString();
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

async function render() {
  const resp = await sendMessage({ type: "listRecords" });
  const items = (resp && resp.ok && resp.items) || [];
  const root = document.getElementById('content');

  if (!items.length) {
    root.innerHTML = '<div class="empty">No records yet. Use the popup to pick blocks on a page.</div>';
    return;
  }

  const table = document.createElement('table');
  table.innerHTML = `
    <thead>
      <tr>
        <th>Source</th>
        <th>Created</th>
        <th>Status</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');

  for (const item of items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="url">${item.sourceUrl ? escapeHtml(item.sourceUrl) : '(no url)'}</td>
      <td>${fmtDate(item.createdAt)}</td>
      <td><span class="status ${item.status || ''}">${item.status || 'unknown'}</span></td>
      <td>
        <button data-action="open" data-key="${item.key}" type="button">Open</button>
        <button data-action="reprocess" data-key="${item.key}" type="button">Reprocess</button>
        <button data-action="delete" data-key="${item.key}" class="danger" type="button">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  root.innerHTML = '';
  root.appendChild(table);

  root.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', onAction);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function onAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  const key = btn.dataset.key;
  if (action === 'delete') {
    if (!confirm('Delete this record?')) return;
    await sendMessage({ type: 'deleteRecord', key });
    render();
  } else if (action === 'reprocess') {
    if (!confirm('Reprocess this record? Existing topics and summaries will be regenerated.')) return;
    await sendMessage({ type: 'reprocessRecord', key });
    render();
  } else if (action === 'open') {
    alert('Open by re-picking the same blocks on the source page.');
  }
}

document.getElementById('delete-all').addEventListener('click', async () => {
  if (!confirm('Delete ALL records?')) return;
  await sendMessage({ type: 'deleteAll' });
  render();
});

render();
