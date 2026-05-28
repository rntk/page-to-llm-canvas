import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

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

function statusClass(status) {
  return `status ${status || ""}`.trim();
}

function OptionsApp() {
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadRecords = useCallback(async () => {
    setIsLoading(true);
    const resp = await sendMessage({ type: "listRecords" });
    setItems((resp && resp.ok && resp.items) || []);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  const deleteAll = async () => {
    if (!confirm("Delete ALL records?")) return;
    await sendMessage({ type: "deleteAll" });
    await loadRecords();
  };

  const runAction = async (action, key) => {
    if (action === "delete") {
      if (!confirm("Delete this record?")) return;
      await sendMessage({ type: "deleteRecord", key });
      await loadRecords();
      return;
    }

    if (action === "reprocess") {
      if (!confirm("Reprocess this record? Existing topics and summaries will be regenerated.")) {
        return;
      }
      await sendMessage({ type: "reprocessRecord", key });
      await loadRecords();
      return;
    }

    if (action === "open") {
      alert("Open by re-picking the same blocks on the source page.");
    }
  };

  return (
    <>
      <h1>PageToLLM Canvas - Stored Records</h1>
      <div className="toolbar">
        <div className="note">Open by re-picking on the source page.</div>
        <button className="danger" type="button" onClick={deleteAll}>
          Delete all
        </button>
      </div>
      <div id="content">
        {isLoading ? (
          <div className="empty">Loading records...</div>
        ) : items.length === 0 ? (
          <div className="empty">No records yet. Use the popup to pick blocks on a page.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Created</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.key}>
                  <td className="url">{item.sourceUrl || "(no url)"}</td>
                  <td>{fmtDate(item.createdAt)}</td>
                  <td>
                    <span className={statusClass(item.status)}>
                      {item.status || "unknown"}
                    </span>
                  </td>
                  <td>
                    <button type="button" onClick={() => runAction("open", item.key)}>
                      Open
                    </button>{" "}
                    <button type="button" onClick={() => runAction("reprocess", item.key)}>
                      Reprocess
                    </button>{" "}
                    <button
                      className="danger"
                      type="button"
                      onClick={() => runAction("delete", item.key)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

const rootEl = document.getElementById("options-root");
createRoot(rootEl).render(<OptionsApp />);
