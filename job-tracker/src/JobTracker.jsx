import React, { useState, useEffect, useMemo } from "react";
import {
  RefreshCw,
  Search,
  Mail,
  Calendar,
  AlertCircle,
  Inbox,
  ChevronDown,
} from "lucide-react";

// ── Stage taxonomy (ordered by pipeline progression) ──────────────────────
const STAGES = [
  "General Conversation",
  "Recruiter Outreach",
  "Applied",
  "Awaiting Response",
  "Screening",
  "Interview Scheduled",
  "Technical/Take-home",
  "Final/Onsite",
  "Offer",
  "Rejected",
];

const CLOSED_STAGES = ["Offer", "Rejected"];

const STAGE_STYLE = {
  "General Conversation":   { bg: "#e7e2d6", fg: "#5c5444", dot: "#9c9276" },
  "Recruiter Outreach":     { bg: "#efe3cf", fg: "#8a5a1f", dot: "#c08a3e" },
  "Applied":                { bg: "#e2e6e4", fg: "#42554b", dot: "#6f8a7c" },
  "Awaiting Response":      { bg: "#f3e6d2", fg: "#9a6418", dot: "#cf922f" },
  "Screening":              { bg: "#e6e9f0", fg: "#3b4a6b", dot: "#5d72a3" },
  "Interview Scheduled":    { bg: "#dce8f0", fg: "#1f4f6b", dot: "#2f7ba3" },
  "Technical/Take-home":    { bg: "#e5e1f0", fg: "#4a3b78", dot: "#6f5dad" },
  "Final/Onsite":           { bg: "#d6ebe6", fg: "#1f6354", dot: "#2f9580" },
  "Offer":                  { bg: "#d9ecd6", fg: "#2f5e2a", dot: "#4f9447" },
  "Rejected":               { bg: "#efdcda", fg: "#8a3b34", dot: "#c0584e" },
};

// ── Prompts ────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You read a user's Gmail and produce a structured job-application / interview tracker. You have Gmail tools available.

TASK:
- Search the user's RECEIVED emails (inbox). Ignore emails the user SENT.
- Find anything tied to job applications, recruiting, interviews, hiring, scheduling calls, take-home/technical assignments, offers, or rejections. Use varied searches (e.g. interview, recruiter, application, position, role, hiring, "next steps", "schedule a call", offer, "move forward", "unfortunately").
- Group emails into distinct OPPORTUNITIES by company + role. Merge threads about the same opportunity.
- Also include lighter items that are not full interviews yet but show a real recruiter/hiring conversation.
- The PRIMARY POINT OF CONTACT is the FIRST person who emailed the user about that opportunity (their display name + email address).
- lastActivity = date of the most recent relevant email in that opportunity.
- Infer the current stage from the latest email.

For each opportunity also decide:
- owes: who needs to send the NEXT message, based on the most recent email. "you" if the ball is in the user's court (they were asked something, need to reply, schedule, or submit). "them" if the user already replied and is waiting on the company/recruiter. "" if neither/closed.
- nextAction: the single concrete next step in plain language (e.g. "Reply with availability", "Submit take-home by Fri", "Await recruiter decision"). Under 9 words.

OUTPUT:
Respond with ONLY valid minified JSON. No markdown, no code fences, no commentary. Match exactly:
{"summary": string, "jobs": [{"company": string, "position": string, "status": <one of: "Applied","Recruiter Outreach","Screening","Interview Scheduled","Technical/Take-home","Final/Onsite","Offer","Rejected","Awaiting Response","General Conversation">, "contactName": string, "contactEmail": string, "lastActivity": "YYYY-MM-DD", "note": string, "owes": <"you"|"them"|"">, "nextAction": string}]}
Keep each note under 14 words. Use "" for unknown fields. Limit to the 40 most relevant opportunities, most recent first.`;

const USER_PROMPT =
  "Scan my inbox and build my current job-interview tracker. Focus only on emails I received. Return only the JSON.";

// ── Helpers ────────────────────────────────────────────────────────────────
function extractJson(text) {
  if (!text) return null;
  let t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(t); } catch (_) {}
  const start = t.indexOf("{");
  const end   = t.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

function fmt(d) {
  if (!d) return "";
  return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function fmtDate(s) {
  if (!s) return "—";
  const d = new Date(s + "T00:00:00");
  if (isNaN(d)) return s;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ── Component ──────────────────────────────────────────────────────────────
export default function JobTracker({ apiKey }) {
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [query, setQuery]         = useState("");
  const [activeStage, setActiveStage] = useState("All");
  const [view, setView]           = useState("Active");
  const [sortDesc, setSortDesc]   = useState(true);

  async function fetchJobs() {
    if (!apiKey) { setError("Enter your Anthropic API key above to get started."); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-beta": "mcp-client-2025-04-04",
        },
        body: JSON.stringify({
          model: "claude-opus-4-8",
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: USER_PROMPT }],
          mcp_servers: [
            {
              type: "url",
              url: "https://mcp.googleapis.com/gmail/sse",
              name: "gmail",
            },
          ],
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `Request failed (${res.status}).`);
      }
      const json = await res.json();
      const text = (json.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const parsed = extractJson(text);
      if (!parsed || !Array.isArray(parsed.jobs)) {
        throw new Error("Could not parse inbox results. Try Refresh again.");
      }
      setData(parsed);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (apiKey) fetchJobs(); }, [apiKey]); // eslint-disable-line

  const jobs = data?.jobs || [];

  const viewCounts = useMemo(() => {
    let active = 0, closed = 0;
    jobs.forEach((j) => (CLOSED_STAGES.includes(j.status) ? closed++ : active++));
    return { active, closed };
  }, [jobs]);

  const scoped = useMemo(() => {
    if (view === "Active") return jobs.filter((j) => !CLOSED_STAGES.includes(j.status));
    if (view === "Closed") return jobs.filter((j) => CLOSED_STAGES.includes(j.status));
    return jobs;
  }, [jobs, view]);

  const counts = useMemo(() => {
    const c = {};
    scoped.forEach((j) => { c[j.status] = (c[j.status] || 0) + 1; });
    return c;
  }, [scoped]);

  const visible = useMemo(() => {
    let list = scoped.filter((j) => {
      if (activeStage !== "All" && j.status !== activeStage) return false;
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return [j.company, j.position, j.contactName, j.contactEmail, j.note, j.nextAction]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q));
    });
    return [...list].sort((a, b) => {
      const da = a.lastActivity || "", db = b.lastActivity || "";
      return sortDesc ? db.localeCompare(da) : da.localeCompare(db);
    });
  }, [scoped, activeStage, query, sortDesc]);

  return (
    <div style={styles.page}>
      <style>{css}</style>

      {/* Header */}
      <header style={styles.header}>
        <div>
          <div style={styles.kicker}>Interview Pipeline</div>
          <h1 style={styles.title}>Job Tracker</h1>
          <p style={styles.sub}>
            Built live from your received Gmail · {jobs.length} opportunit{jobs.length === 1 ? "y" : "ies"}
            {lastUpdated ? " · updated " + fmt(lastUpdated) : ""}
          </p>
        </div>
        <button onClick={fetchJobs} disabled={loading} style={styles.refreshBtn} className="refresh-btn">
          <RefreshCw size={16} className={loading ? "spin" : ""} />
          {loading ? "Reading inbox…" : "Refresh"}
        </button>
      </header>

      {data?.summary && !loading && (
        <div style={styles.summaryNote}>
          <Inbox size={15} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{data.summary}</span>
        </div>
      )}

      {/* View tabs */}
      {jobs.length > 0 && (
        <div style={styles.tabs}>
          {[["Active", viewCounts.active], ["Closed", viewCounts.closed], ["All", jobs.length]].map(([v, n]) => (
            <button key={v} onClick={() => { setView(v); setActiveStage("All"); }}
              style={{ ...styles.tab, ...(view === v ? styles.tabActive : {}) }}>
              {v} <span style={styles.tabCount}>{n}</span>
            </button>
          ))}
        </div>
      )}

      {/* Stage chips */}
      {jobs.length > 0 && (
        <div style={styles.chipRow}>
          <button className="chip" onClick={() => setActiveStage("All")}
            style={{ ...styles.chip, ...(activeStage === "All" ? styles.chipActive : {}) }}>
            All <span style={styles.chipCount}>{scoped.length}</span>
          </button>
          {STAGES.filter((s) => counts[s]).map((s) => {
            const st = STAGE_STYLE[s];
            const on = activeStage === s;
            return (
              <button key={s} className="chip" onClick={() => setActiveStage(on ? "All" : s)}
                style={{ ...styles.chip, background: on ? st.bg : "transparent", color: on ? st.fg : "#6b6453", borderColor: on ? st.dot : "#d8d0bf" }}>
                <span style={{ ...styles.dot, background: st.dot }} />
                {s} <span style={styles.chipCount}>{counts[s]}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Search + sort */}
      {jobs.length > 0 && (
        <div style={styles.controls}>
          <div style={styles.searchWrap}>
            <Search size={16} style={{ color: "#9c9276" }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search company, role, contact…" style={styles.search} />
          </div>
          <button onClick={() => setSortDesc((v) => !v)} style={styles.sortBtn} className="refresh-btn">
            <Calendar size={14} />
            {sortDesc ? "Newest first" : "Oldest first"}
            <ChevronDown size={14} style={{ transform: sortDesc ? "none" : "rotate(180deg)" }} />
          </button>
        </div>
      )}

      {/* States */}
      {loading && !data && (
        <div style={styles.center}>
          <RefreshCw size={26} className="spin" style={{ color: "#c4622d" }} />
          <p style={styles.muted}>Reading your inbox and grouping conversations…</p>
        </div>
      )}

      {error && (
        <div style={styles.errorBox}>
          <AlertCircle size={18} style={{ flexShrink: 0 }} />
          <div>
            <strong>{error}</strong>
            <div style={{ fontSize: 13, marginTop: 4, opacity: 0.8 }}>
              Make sure Gmail is connected and your API key is correct, then press Refresh.
            </div>
          </div>
        </div>
      )}

      {!loading && !error && data && visible.length === 0 && (
        <div style={styles.center}>
          <Mail size={26} style={{ color: "#9c9276" }} />
          <p style={styles.muted}>
            {jobs.length === 0
              ? "No interview conversations found in your received mail yet."
              : "Nothing matches this filter."}
          </p>
        </div>
      )}

      {/* Table */}
      {visible.length > 0 && (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                {["Company", "Position", "Stage", "Point of Contact", "Last Activity", "Next Action", "Notes"].map((h) => (
                  <th key={h} style={styles.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((j, i) => {
                const st = STAGE_STYLE[j.status] || STAGE_STYLE["General Conversation"];
                return (
                  <tr key={i} className="row" style={{ animationDelay: i * 28 + "ms" }}>
                    <td style={{ ...styles.td, fontWeight: 600, color: "#26231c" }}>{j.company || "—"}</td>
                    <td style={styles.td}>{j.position || "—"}</td>
                    <td style={styles.td}>
                      <span style={{ ...styles.badge, background: st.bg, color: st.fg }}>
                        <span style={{ ...styles.dot, background: st.dot }} />
                        {j.status}
                      </span>
                    </td>
                    <td style={styles.td}>
                      <div style={{ fontWeight: 500, color: "#3a352b" }}>{j.contactName || "—"}</div>
                      {j.contactEmail && (
                        <a href={"mailto:" + j.contactEmail} style={styles.email}>{j.contactEmail}</a>
                      )}
                    </td>
                    <td style={{ ...styles.td, whiteSpace: "nowrap", color: "#6b6453" }}>{fmtDate(j.lastActivity)}</td>
                    <td style={styles.td}>
                      {j.owes === "you" && (
                        <span style={styles.owesYou}>
                          <span style={{ ...styles.dot, background: "#cf922f" }} />Your move
                        </span>
                      )}
                      {j.owes === "them" && (
                        <span style={styles.owesThem}>
                          <span style={{ ...styles.dot, background: "#9c9276" }} />Awaiting them
                        </span>
                      )}
                      {j.nextAction && (
                        <div style={{ marginTop: j.owes ? 6 : 0, color: "#4f4838", fontSize: 13.5 }}>{j.nextAction}</div>
                      )}
                      {!j.owes && !j.nextAction && <span style={{ color: "#b3aa97" }}>—</span>}
                    </td>
                    <td style={{ ...styles.td, color: "#6b6453", fontSize: 13.5 }}>{j.note || ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <footer style={styles.footer}>
        Reads received emails only · grouped by company + role · point of contact = first sender.
        Refresh each morning to fold in new mail.
      </footer>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Hanken+Grotesk:wght@400;500;600&display=swap');
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  .spin { animation: spin 0.9s linear infinite; }
  .row { animation: fadeUp 0.4s ease both; }
  .row:hover { background: #f1ece0 !important; }
  .refresh-btn:hover { background: #2f2a20 !important; color: #f4f0e8 !important; }
  .chip:hover { border-color: #b9af9a !important; }
  ::-webkit-scrollbar { height: 10px; width: 10px; }
  ::-webkit-scrollbar-thumb { background: #d8d0bf; border-radius: 8px; }
  input::placeholder { color: #b3aa97; }
`;

const styles = {
  page: {
    minHeight: "100vh",
    background: "radial-gradient(120% 120% at 0% 0%, #faf7ef 0%, #f1ebdd 100%)",
    fontFamily: "'Hanken Grotesk', sans-serif",
    color: "#3a352b",
    padding: "32px clamp(16px, 4vw, 48px) 56px",
    boxSizing: "border-box",
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap", marginBottom: 22 },
  kicker: { textTransform: "uppercase", letterSpacing: "0.18em", fontSize: 11, fontWeight: 600, color: "#c4622d" },
  title: { fontFamily: "'Fraunces', serif", fontSize: "clamp(34px, 6vw, 52px)", fontWeight: 600, margin: "4px 0 6px", color: "#26231c", lineHeight: 1 },
  sub: { margin: 0, fontSize: 14, color: "#7a7261" },
  refreshBtn: { display: "inline-flex", alignItems: "center", gap: 8, background: "#26231c", color: "#f4f0e8", border: "none", borderRadius: 999, padding: "11px 20px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all 0.18s ease" },
  summaryNote: { display: "flex", gap: 10, alignItems: "flex-start", background: "#fff", border: "1px solid #e7dfce", borderRadius: 14, padding: "14px 18px", fontSize: 14.5, color: "#5c5444", marginBottom: 20, lineHeight: 1.5 },
  chipRow: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 },
  chip: { display: "inline-flex", alignItems: "center", gap: 7, border: "1px solid #d8d0bf", background: "transparent", borderRadius: 999, padding: "7px 13px", fontSize: 13, fontWeight: 500, cursor: "pointer", color: "#6b6453", fontFamily: "inherit", transition: "all 0.15s ease" },
  chipActive: { background: "#26231c", color: "#f4f0e8", borderColor: "#26231c" },
  chipCount: { fontWeight: 700, opacity: 0.65, fontSize: 12 },
  dot: { width: 7, height: 7, borderRadius: "50%", display: "inline-block" },
  tabs: { display: "inline-flex", gap: 4, background: "#ece4d3", border: "1px solid #e0d7c4", borderRadius: 12, padding: 4, marginBottom: 18 },
  tab: { border: "none", background: "transparent", borderRadius: 9, padding: "8px 16px", fontSize: 13.5, fontWeight: 600, color: "#7a7261", cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s ease" },
  tabActive: { background: "#fffdf8", color: "#26231c", boxShadow: "0 2px 6px -2px rgba(60,50,30,0.25)" },
  tabCount: { fontWeight: 700, opacity: 0.5, fontSize: 12, marginLeft: 3 },
  owesYou: { display: "inline-flex", alignItems: "center", gap: 6, background: "#f3e6d2", color: "#9a6418", borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" },
  owesThem: { display: "inline-flex", alignItems: "center", gap: 6, background: "#eae5d8", color: "#6b6453", borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" },
  controls: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16, alignItems: "center" },
  searchWrap: { display: "flex", alignItems: "center", gap: 9, background: "#fff", border: "1px solid #e2dac9", borderRadius: 12, padding: "10px 14px", flex: "1 1 280px", maxWidth: 420 },
  search: { border: "none", outline: "none", background: "transparent", fontSize: 14, fontFamily: "inherit", color: "#3a352b", width: "100%" },
  sortBtn: { display: "inline-flex", alignItems: "center", gap: 7, background: "#fff", border: "1px solid #e2dac9", borderRadius: 12, padding: "10px 14px", fontSize: 13, fontWeight: 500, color: "#5c5444", cursor: "pointer", fontFamily: "inherit", transition: "all 0.18s ease" },
  tableWrap: { background: "#fffdf8", border: "1px solid #e7dfce", borderRadius: 18, overflow: "hidden", overflowX: "auto", boxShadow: "0 18px 40px -28px rgba(60,50,30,0.35)" },
  table: { width: "100%", borderCollapse: "collapse", minWidth: 920 },
  th: { textAlign: "left", padding: "15px 18px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#9c9276", fontWeight: 700, borderBottom: "1px solid #ece4d3", background: "#f7f2e7" },
  td: { padding: "15px 18px", fontSize: 14, borderBottom: "1px solid #f0e9d9", verticalAlign: "top" },
  badge: { display: "inline-flex", alignItems: "center", gap: 6, borderRadius: 999, padding: "5px 11px", fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" },
  email: { fontSize: 12.5, color: "#9c7a3e", textDecoration: "none" },
  center: { display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "70px 20px", textAlign: "center" },
  muted: { color: "#8a8270", fontSize: 14.5, margin: 0 },
  errorBox: { display: "flex", gap: 12, alignItems: "flex-start", background: "#f7e4e1", border: "1px solid #e3b5ae", color: "#8a3b34", borderRadius: 14, padding: "16px 18px", fontSize: 14 },
  footer: { marginTop: 26, fontSize: 12.5, color: "#a39a85", textAlign: "center", lineHeight: 1.6 },
};
