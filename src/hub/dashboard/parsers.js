// Dashboard response parsers.
//
// Moved out of the inline <script> in dashboard.html so Phase 6 can cover
// them with fixture-backed tests. Every function in this module is called
// from event handlers on the dashboard; behaviour is a direct port of the
// pre-extraction inline block. Do not change parser behaviour here —
// fixes belong in a dedicated phase after fixtures exist.

// Serialize an arbitrary value to a stable string for UI display. Mirrors
// the inline `tryJson` helper from dashboard.html so this module is
// self-contained.
function tryJson(v) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// Parse Read tool responses.
export function parseReadContent(resp) {
  if (resp && typeof resp === "object" && !Array.isArray(resp)) {
    const f = resp.file;
    if (f && typeof f.content === "string") {
      const start = typeof f.startLine === "number" ? f.startLine : 1;
      const lines = f.content.split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      const rows = [];
      for (let i = 0; i < lines.length; i++) {
        rows.push({ n: String(start + i), text: lines[i] });
      }
      return {
        rows,
        totalLines:
          typeof f.totalLines === "number" ? f.totalLines : rows.length,
        startLine: start,
      };
    }
    const unwrapped = unwrapMcpText(resp);
    if (unwrapped !== null) {
      try {
        return parseReadContent(JSON.parse(unwrapped));
      } catch {
        return parseReadTextLines(unwrapped);
      }
    }
  }
  if (typeof resp === "string") return parseReadTextLines(resp);
  return { rows: [], totalLines: 0, startLine: 1 };
}

// Fallback for the cat -n string shape, or raw text with no line
// prefixes at all — synthesise 1-based numbering.
export function parseReadTextLines(text) {
  if (!text) return { rows: [], totalLines: 0, startLine: 1 };
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const rows = [];
  const rx = /^\s*(\d+)\t(.*)$/;
  let start = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(rx);
    if (m) {
      if (start === null) start = Number(m[1]);
      rows.push({ n: m[1], text: m[2] });
    } else {
      rows.push({ n: String(i + 1), text: lines[i] });
    }
  }
  return {
    rows,
    totalLines: rows.length,
    startLine: start || 1,
  };
}

// Defensive extractor for list_agents / list_teams responses.
// MCP tool responses arrive as an array (or { content: [...] }) of
// { type: 'text', text: '<JSON>' } blocks — unwrap those, then
// JSON-parse the joined text, before looking for the list.
export function extractCnList(resp, key) {
  const text = unwrapMcpText(resp);
  if (text !== null) {
    try {
      return extractCnList(JSON.parse(text), key);
    } catch {
      /* not JSON */
    }
  }
  if (Array.isArray(resp)) return resp;
  if (resp && typeof resp === "object") {
    if (Array.isArray(resp[key])) return resp[key];
    if (Array.isArray(resp.items)) return resp.items;
  }
  if (typeof resp === "string") {
    try {
      const parsed = JSON.parse(resp);
      return extractCnList(parsed, key);
    } catch {
      /* not JSON */
    }
  }
  return [];
}

// If `resp` looks like an MCP text-content envelope, join the text
// blocks and return the concatenated string. Returns null if this
// wasn't an envelope. Callers JSON.parse if they expect JSON —
// WebSearch etc. use the raw string as-is.
export function unwrapMcpText(resp) {
  let blocks = null;
  if (Array.isArray(resp)) blocks = resp;
  else if (resp && typeof resp === "object" && Array.isArray(resp.content))
    blocks = resp.content;
  if (!blocks || blocks.length === 0) return null;
  for (let i = 0; i < blocks.length; i++) {
    if (!blocks[i] || typeof blocks[i].text !== "string") return null;
  }
  return blocks.map((b) => b.text).join("");
}

// Pull tool names out of a ToolSearch response. The tool returns a
// <functions>...</functions> block with one <function>{...}</function>
// per match; the JSON carries a top-level "name" field per tool.
export function extractToolSearchNames(text) {
  const names = [];
  if (!text) return names;
  const rx = /"name"\s*:\s*"([^"]+)"/g;
  let m = rx.exec(text);
  while (m !== null) {
    names.push(m[1]);
    if (names.length >= 100) break;
    m = rx.exec(text);
  }
  return names;
}

// Pull a best-effort [{ title, url, snippet }] list out of the many
// shapes WebSearch responses can take. The tool returns either a
// plain string (the canonical "Web search results for query: ...\n\n
// Links: [...]\n\n...snippets...") or a structured object; be
// defensive so one format change doesn't silently blank the view.
export function extractWebSearchResults(resp) {
  const out = [];
  if (!resp) return out;
  const unwrapped = unwrapMcpText(resp);
  if (unwrapped !== null) {
    try {
      return extractWebSearchResults(JSON.parse(unwrapped));
    } catch {
      return extractWebSearchResults(unwrapped);
    }
  }
  // Claude Code's native WebSearch shape:
  //   { query, results: [ {tool_use_id, content: [{title,url},…]}, "<AI summary>", … ] }
  // The `results` array is heterogeneous — objects with a nested
  // content list, plus plain strings for the prose summary.
  if (
    typeof resp === "object" &&
    !Array.isArray(resp) &&
    Array.isArray(resp.results)
  ) {
    for (let ri = 0; ri < resp.results.length; ri++) {
      const entry = resp.results[ri];
      if (entry && typeof entry === "object" && Array.isArray(entry.content)) {
        for (let ci = 0; ci < entry.content.length; ci++) {
          const c = entry.content[ci];
          if (c && (c.url || c.link)) {
            out.push({
              title: c.title || "",
              url: c.url || c.link,
              snippet: c.snippet || c.description || "",
            });
          }
        }
      } else if (
        entry &&
        typeof entry === "object" &&
        (entry.url || entry.link)
      ) {
        out.push({
          title: entry.title || "",
          url: entry.url || entry.link,
          snippet: entry.snippet || entry.description || "",
        });
      }
    }
    if (out.length) return out;
  }
  // Fall-through envelopes.
  if (typeof resp === "object" && !Array.isArray(resp)) {
    if (typeof resp.output === "string")
      return extractWebSearchResults(resp.output);
    if (typeof resp.text === "string")
      return extractWebSearchResults(resp.text);
    const arr = Array.isArray(resp.links) ? resp.links : null;
    if (arr) {
      for (let i = 0; i < arr.length; i++) {
        const r = arr[i] || {};
        if (r.url || r.link) {
          out.push({
            title: r.title || r.name || "",
            url: r.url || r.link,
            snippet: r.snippet || r.description || r.summary || "",
          });
        }
      }
      if (out.length) return out;
    }
  }
  if (Array.isArray(resp)) {
    for (let j = 0; j < resp.length; j++) {
      const rr = resp[j] || {};
      if (rr.url || rr.link) {
        out.push({
          title: rr.title || "",
          url: rr.url || rr.link,
          snippet: rr.snippet || rr.description || "",
        });
      }
    }
    if (out.length) return out;
  }
  // Fall through: parse the string form.
  const text = typeof resp === "string" ? resp : "";
  if (!text) return out;
  // Pull the JSON array that follows "Links:".
  const m = text.match(/Links:\s*(\[[\s\S]*?\])\s*\n/);
  if (m) {
    try {
      const links = JSON.parse(m[1]);
      if (Array.isArray(links)) {
        for (let k = 0; k < links.length; k++) {
          const l = links[k] || {};
          if (l.url) {
            out.push({ title: l.title || "", url: l.url, snippet: "" });
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function hostFromUrl(u) {
  if (!u) return "";
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

// Collapse WebSearch's possibly-wrapped response into a single text
// string. Handles plain strings, MCP envelopes, { output } / { text }
// objects, and falls back to JSON.stringify for anything else.
export function toWebSearchText(resp) {
  if (typeof resp === "string") return resp;
  const unwrapped = unwrapMcpText(resp);
  if (unwrapped !== null) return unwrapped;
  if (resp && typeof resp === "object") {
    if (typeof resp.output === "string") return resp.output;
    if (typeof resp.text === "string") return resp.text;
  }
  return tryJson(resp);
}

// Pull the AI-generated summary out of a WebSearch response. The
// native shape puts one or more prose strings inside resp.results
// alongside the link objects; the legacy string shape had the
// prose follow a "Links: [...]" line. Trailing "REMINDER: ..."
// sentinel text gets trimmed in either case.
export function extractWebSearchSummary(resp) {
  if (!resp) return "";
  let raw = "";
  if (
    typeof resp === "object" &&
    !Array.isArray(resp) &&
    Array.isArray(resp.results)
  ) {
    const chunks = [];
    for (let i = 0; i < resp.results.length; i++) {
      const r = resp.results[i];
      if (typeof r === "string") chunks.push(r);
    }
    raw = chunks.join("\n\n");
  } else if (typeof resp === "string") {
    const m = resp.match(/Links:\s*\[[\s\S]*?\]\s*\n+([\s\S]*)$/);
    raw = m ? m[1] : resp;
  }
  return raw.replace(/\n+REMINDER:[\s\S]*$/i, "").trim();
}
