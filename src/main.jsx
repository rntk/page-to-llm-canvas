import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./modal.css";

function getKeyFromLocation() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("key") || "";
  } catch (_) {
    return "";
  }
}

const container = document.getElementById("pagetollm-root");
const root = createRoot(container);
root.render(<App initialKey={getKeyFromLocation()} />);
