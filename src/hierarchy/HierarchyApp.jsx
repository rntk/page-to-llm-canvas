import React, { useMemo } from "react";
import { useRecord } from "../useRecord.js";
import TopicHierarchyView from "./TopicHierarchyView.jsx";
import "./hierarchy.css";

function closeView() {
  try {
    window.parent.postMessage({ type: "pagetollm-close" }, "*");
  } catch (_) {
    /* noop */
  }
}

export default function HierarchyApp({ initialKey }) {
  const { record, error } = useRecord(initialKey);
  const topics = useMemo(
    () => (Array.isArray(record?.topics) ? record.topics : []),
    [record],
  );
  const isDone = record?.status === "done";

  let body;
  if (error && !record) {
    body = <div className="th-page__state">Error: {String(error)}</div>;
  } else if (!record) {
    body = <div className="th-page__state">Loading…</div>;
  } else if (!isDone) {
    body = <div className="th-page__state">Still processing this page…</div>;
  } else {
    body = <TopicHierarchyView topics={topics} />;
  }

  return (
    <div className="th-page">
      <header className="th-page__bar">
        <h1 className="th-page__title">Topic Hierarchy</h1>
        <button
          type="button"
          className="th-page__close"
          onClick={closeView}
          title="Close"
        >
          ×
        </button>
      </header>
      <div className="th-page__body">{body}</div>
    </div>
  );
}
