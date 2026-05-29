import React, { useState, useEffect, useRef } from "react";
import { Key, Eye, EyeOff, Clock } from "lucide-react";
import JobTracker from "./JobTracker.jsx";

const LS_KEY = "jt_anthropic_api_key";
const LS_INTERVAL = "jt_refresh_interval_mins";

const INTERVALS = [
  { label: "Manual only", value: 0 },
  { label: "Every 30 min", value: 30 },
  { label: "Every hour", value: 60 },
  { label: "Every 4 hours", value: 240 },
  { label: "Every 8 hours", value: 480 },
];

export default function App() {
  const [apiKey, setApiKey]         = useState(() => localStorage.getItem(LS_KEY) || "");
  const [draft, setDraft]           = useState(() => localStorage.getItem(LS_KEY) || "");
  const [show, setShow]             = useState(false);
  const [saved, setSaved]           = useState(!!localStorage.getItem(LS_KEY));
  const [intervalMins, setIntervalMins] = useState(
    () => parseInt(localStorage.getItem(LS_INTERVAL) || "60", 10)
  );

  // Keep a stable ref to the JobTracker's fetchJobs so the interval can call it
  const trackerRef = useRef(null);

  function saveKey() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    localStorage.setItem(LS_KEY, trimmed);
    setApiKey(trimmed);
    setSaved(true);
  }

  function clearKey() {
    localStorage.removeItem(LS_KEY);
    setApiKey("");
    setDraft("");
    setSaved(false);
  }

  function handleIntervalChange(e) {
    const v = parseInt(e.target.value, 10);
    setIntervalMins(v);
    localStorage.setItem(LS_INTERVAL, String(v));
  }

  // Auto-refresh: poke the hidden refresh button on the tracker
  useEffect(() => {
    if (!intervalMins || !apiKey) return;
    const id = setInterval(() => {
      const btn = document.getElementById("jt-refresh-btn");
      if (btn) btn.click();
    }, intervalMins * 60 * 1000);
    return () => clearInterval(id);
  }, [intervalMins, apiKey]);

  const showSetup = !saved || !apiKey;

  return (
    <div>
      {/* ── API key + settings panel ── */}
      <div style={panel.wrap}>
        <div style={panel.inner}>
          <div style={panel.left}>
            <Key size={15} style={{ color: "#c4622d", flexShrink: 0, marginTop: 1 }} />
            <span style={panel.label}>Anthropic API key</span>
            <div style={panel.inputWrap}>
              <input
                type={show ? "text" : "password"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveKey()}
                placeholder="sk-ant-…"
                style={panel.input}
                autoComplete="off"
                spellCheck={false}
              />
              <button onClick={() => setShow((v) => !v)} style={panel.eyeBtn} title={show ? "Hide" : "Show"}>
                {show ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {!saved ? (
              <button onClick={saveKey} disabled={!draft.trim()} style={panel.saveBtn}>Save</button>
            ) : (
              <button onClick={clearKey} style={{ ...panel.saveBtn, background: "transparent", color: "#8a3b34", border: "1px solid #e3b5ae" }}>
                Clear
              </button>
            )}
            {saved && <span style={panel.savedDot}>● Saved</span>}
          </div>

          <div style={panel.right}>
            <Clock size={14} style={{ color: "#9c9276" }} />
            <span style={panel.label}>Auto-refresh</span>
            <select value={intervalMins} onChange={handleIntervalChange} style={panel.select}>
              {INTERVALS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        {showSetup && (
          <div style={panel.hint}>
            Enter your Anthropic API key (starts with <code>sk-ant-</code>) to connect to Gmail and populate the tracker.
            The key is stored only in your browser's local storage.
          </div>
        )}
      </div>

      {/* ── Tracker ── */}
      <JobTracker apiKey={apiKey} ref={trackerRef} />

      {/* Hidden proxy button so the interval can trigger a refresh */}
      <button id="jt-refresh-btn" style={{ display: "none" }} aria-hidden="true" />
    </div>
  );
}

const panel = {
  wrap: {
    background: "#f7f2e8",
    borderBottom: "1px solid #e0d7c4",
    padding: "14px clamp(16px, 4vw, 48px)",
    fontFamily: "'Hanken Grotesk', system-ui, sans-serif",
  },
  inner: {
    display: "flex",
    flexWrap: "wrap",
    gap: "12px 28px",
    alignItems: "center",
  },
  left: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  right: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  label: { fontSize: 13, fontWeight: 600, color: "#5c5444" },
  inputWrap: {
    display: "flex",
    alignItems: "center",
    background: "#fff",
    border: "1px solid #d8d0bf",
    borderRadius: 8,
    padding: "0 8px",
    gap: 4,
  },
  input: {
    border: "none",
    outline: "none",
    background: "transparent",
    fontSize: 13,
    fontFamily: "monospace",
    color: "#3a352b",
    width: 220,
    padding: "7px 0",
  },
  eyeBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "#9c9276",
    display: "flex",
    padding: 0,
  },
  saveBtn: {
    background: "#26231c",
    color: "#f4f0e8",
    border: "none",
    borderRadius: 8,
    padding: "7px 14px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  savedDot: { fontSize: 12, color: "#4f9447", fontWeight: 600 },
  select: {
    border: "1px solid #d8d0bf",
    borderRadius: 8,
    padding: "7px 10px",
    fontSize: 13,
    fontFamily: "inherit",
    background: "#fff",
    color: "#3a352b",
    cursor: "pointer",
  },
  hint: {
    marginTop: 10,
    fontSize: 12.5,
    color: "#7a7261",
    lineHeight: 1.5,
  },
};
