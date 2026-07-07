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

// Whitelist of image media types we will render inline. SVG is excluded
// because SVG can carry script content; if a future renderer ever inlines
// it as raw markup it becomes an XSS vector. PNG/JPEG/GIF/WEBP are
// rendered via <img src=data:...> where the browser refuses to execute
// embedded scripts.
const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// Extract image content blocks from a tool_result response. Returns
// [{ media_type, data, bytes }, …] for each base64 image block whose
// media_type is on the IMAGE_MEDIA_TYPES allowlist; everything else is
// skipped. Walks the three shapes Claude Code emits:
//   - bare array of blocks                       [{type:"image", …}, …]
//   - MCP envelope                              { content: [{type:"image", …}, …] }
//   - nested image inside a wrapper             { …, image: {type:"image", …} }
// Field order inside the source object is not enforced (media_type may
// appear before or after data).
//
// Also recognises the over-cap placeholder emitted by the mirror-agent
// (`{type:"image_placeholder", media_type, bytes, reason}`) and includes
// it in the returned list with `data:null` so the renderer can show a
// non-blank "image too large" tile rather than nothing.
export function extractImageBlocks(resp) {
  const out = [];
  if (!resp) return out;
  walkForImages(resp, out, 0);
  return out;
}

function walkForImages(node, out, depth) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++)
      walkForImages(node[i], out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  // Image block? Accept the canonical Claude Code shape and the mirror-
  // agent's over-cap placeholder.
  if (node.type === "image" && node.source && typeof node.source === "object") {
    const src = node.source;
    const mt = typeof src.media_type === "string" ? src.media_type : "";
    const data = typeof src.data === "string" ? src.data : "";
    if (IMAGE_MEDIA_TYPES.has(mt) && data) {
      // Approximate decoded byte size: base64 expands by ~4/3.
      const bytes = Math.ceil((data.length * 3) / 4);
      out.push({ media_type: mt, data, bytes });
    }
    return;
  }
  if (node.type === "image_placeholder") {
    const mt = typeof node.media_type === "string" ? node.media_type : "";
    const bytes = typeof node.bytes === "number" ? node.bytes : 0;
    const reason =
      typeof node.reason === "string" ? node.reason : "unavailable";
    out.push({ media_type: mt, data: null, bytes, reason });
    return;
  }
  // Otherwise recurse into common envelope fields. Avoid `source.data`
  // (already handled above) and bail on giant text fields.
  if (Array.isArray(node.content)) walkForImages(node.content, out, depth + 1);
  if (Array.isArray(node.results)) walkForImages(node.results, out, depth + 1);
  if (node.image) walkForImages(node.image, out, depth + 1);
  if (Array.isArray(node.attachments))
    walkForImages(node.attachments, out, depth + 1);
}

// Extract file references (path + metadata) from a tool_result response.
// Targets the SendUserFile attachment shape —
//   { attachments: [{ path, size, isImage, media_type, file_uuid }, …] }
// — but also matches any nested object that carries a string `path`
// alongside at least one file-ish sibling key, so a tool that reports
// delivered files under a different envelope still surfaces them. Unlike
// extractImageBlocks these entries have NO bytes; the dashboard fetches
// the content on demand from the mirror-agent via /api/mirror/:sid/file.
// Deduplicated by path, capped so a pathological response can't produce an
// unbounded card list.
const FILE_REF_SIBLINGS = ["media_type", "isImage", "size", "file_uuid"];
export function extractFileRefs(resp) {
  const out = [];
  const seen = new Set();
  walkForFileRefs(resp, out, seen, 0);
  return out;
}

function walkForFileRefs(node, out, seen, depth) {
  if (!node || depth > 6 || out.length >= 64) return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++)
      walkForFileRefs(node[i], out, seen, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  if (typeof node.path === "string" && node.path) {
    let fileish = false;
    for (let i = 0; i < FILE_REF_SIBLINGS.length; i++) {
      if (FILE_REF_SIBLINGS[i] in node) {
        fileish = true;
        break;
      }
    }
    if (fileish && !seen.has(node.path)) {
      seen.add(node.path);
      const mt = typeof node.media_type === "string" ? node.media_type : "";
      out.push({
        path: node.path,
        media_type: mt,
        size: typeof node.size === "number" ? node.size : null,
        isImage:
          node.isImage === true || (mt !== "" && mt.indexOf("image/") === 0),
        name: node.path.split("/").pop() || node.path,
      });
      // Don't recurse into an entry we've already captured.
      return;
    }
  }
  for (const k in node) {
    if (Object.prototype.hasOwnProperty.call(node, k))
      walkForFileRefs(node[k], out, seen, depth + 1);
  }
}

// Split a string into ordered segments, tagging each absolute-path run so
// the dashboard can linkify paths mentioned in prose without disturbing the
// surrounding text. Returns [{ text, path }] where `path` is the matched
// absolute path for path segments and null otherwise. `~`-rooted paths are
// left as-is here (the browser can't know the agent's home dir) — the fetch
// endpoint resolves them agent-side. Trailing prose punctuation is excluded
// from the path but preserved in the following text segment.
// The (?<![\w~]) lookbehind keeps "/4" in "3/4" and "b" in "a/b" from
// matching — a path must start at a boundary, not mid-token.
const TEXT_PATH_RE = /(?<![\w~])(?:~|(?=\/))(?:\/[\w.+@\-]+)+/g;
export function splitTextPaths(text) {
  const segs = [];
  if (!text) return segs;
  let last = 0;
  let m;
  TEXT_PATH_RE.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((m = TEXT_PATH_RE.exec(text)) !== null) {
    const start = m.index;
    // Trim trailing punctuation that abuts a path in prose; the trimmed
    // characters fall into the following text segment.
    const matched = m[0].replace(/[.,;:)\]}'"]+$/, "");
    // A bare "/" or a single-segment root isn't a useful link.
    if (matched.length < 2) continue;
    if (start > last) segs.push({ text: text.slice(last, start), path: null });
    segs.push({ text: matched, path: matched });
    last = start + matched.length;
  }
  if (last < text.length) segs.push({ text: text.slice(last), path: null });
  return segs;
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
  // Concat only the text blocks. Mixed-content arrays (e.g. text + image)
  // used to return null here, losing the text portion entirely; now we
  // keep the text and let extractImageBlocks pull the images out
  // separately. If no block has text, treat as not-an-envelope so callers
  // fall through to their other shapes.
  const parts = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b && typeof b.text === "string") parts.push(b.text);
  }
  if (parts.length === 0) return null;
  return parts.join("");
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
/**
 * Parse the augmented notification text the mirror-agent emits when
 * it scrapes a numbered Claude Code modal off the tmux pane. The
 * shape is roughly:
 *   <title line(s)>
 *
 *   1. option text
 *   2. option text
 *   …
 *
 * Returns `{ title, options: [{key, label}] }`, or `null` when the
 * text contains no numbered options (e.g. the title-only notification
 * fired before the pane scrape ran).
 */
export function parsePromptMenu(text) {
  if (!text || typeof text !== "string") return null;
  const lines = text.split("\n");
  const optionRx = /^\s*(\d{1,2})\.\s+(.+?)\s*$/;
  const options = [];
  const titleLines = [];
  let seenOption = false;
  for (const ln of lines) {
    const m = ln.match(optionRx);
    if (m) {
      seenOption = true;
      options.push({ key: m[1], label: m[2] });
      continue;
    }
    if (!seenOption && ln.trim().length > 0) {
      titleLines.push(ln.trim());
    }
  }
  if (options.length === 0) return null;
  return { title: titleLines.join(" ").trim(), options };
}

/**
 * Compose the tmux key-sequence that answers a multi-question
 * AskUserQuestion modal. Per question:
 *   - option j (0-based) → Down × j, Enter
 *   - free text          → Down × N (one past the supplied options,
 *                          landing on Claude Code's built-in "Type
 *                          something." slot), Enter, text, Enter
 * After the last question's Enter the modal lands on its review
 * tab; "Submit answers" is the default highlight, so one final
 * Enter accepts the batch.
 */
export function buildAskUserQuestionKeys(questions, answers) {
  const parts = [];
  for (let i = 0; i < questions.length; i++) {
    const answer = answers[i];
    const opts = questions[i]?.options || [];
    if (!answer) continue;
    if (answer.kind === "option") {
      for (let d = 0; d < answer.index; d++) {
        parts.push({ type: "key", name: "Down" });
      }
      parts.push({ type: "key", name: "Enter" });
    } else if (answer.kind === "text") {
      for (let dd = 0; dd < opts.length; dd++) {
        parts.push({ type: "key", name: "Down" });
      }
      parts.push({ type: "key", name: "Enter" });
      if (answer.value && answer.value.length > 0) {
        parts.push({ type: "text", value: answer.value });
      }
      parts.push({ type: "key", name: "Enter" });
    }
  }
  parts.push({ type: "key", name: "Enter" });
  return parts;
}

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
