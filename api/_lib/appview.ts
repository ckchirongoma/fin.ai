// Charles — the plan, the step and the map, drawn inside Claude and ChatGPT.
//
// Round 28, the founder: "render within ChatGPT and Claude". Both speak MCP
// Apps (SEP-1865, io.modelcontextprotocol/ui, stable 2026-01-26): a tool
// names a `ui://` resource in `_meta.ui.resourceUri`, the host reads that
// resource (an HTML page) once, shows it in a sandboxed frame under the
// tool's answer, and hands it the tool's `structuredContent` over
// postMessage (`ui/notifications/tool-result`). ChatGPT also still reads its
// Apps SDK key, `_meta["openai/outputTemplate"]`, pointing at a resource
// served as `text/html+skybridge`, and gives the page `window.openai`. So the
// same page is published under both, and it listens on both bridges. A host
// with neither shows the tool's text, exactly as before.
//
// The page is static: no owner data is in it. Everything it shows arrives in
// the tool result the person's AI already received, so it can never show one
// person's business to another, and it fetches nothing from anywhere (an
// empty CSP: the host's strictest default holds).
//
// Built like the plan document (CLAUDE.md rule 8): every layout is a
// `<table role="presentation">`, every colour an inline hex, no CSS Grid,
// Flexbox, custom properties or negative margins. An AI app's frame is
// exactly the "unpredictable range of renderers" that rule was written for.
//
// Every button is an action (rule 7): it calls one named tool with explicit
// arguments through the host — "I've done it" is complete_step, the outcome
// buttons are report_outcome — and the same rules hold as when the AI calls
// them: a change to the plan still goes through the person on WhatsApp.

/** The page, as MCP Apps hosts (Claude, and ChatGPT's preferred path) read it. */
export const VIEW_URI = "ui://charles/view.html";
/** The same page under ChatGPT's Apps SDK key. */
export const VIEW_URI_CHATGPT = "ui://charles/view-chatgpt.html";
export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const SKYBRIDGE_MIME = "text/html+skybridge";
/** The extension's id, for capability checks and the docs. */
export const UI_EXTENSION = "io.modelcontextprotocol/ui";

const DESCRIPTION = "Your 90-day money plan, the step you're on and your money map, drawn in the chat, with buttons to tick a step off.";

/** What resources/list returns to a person's AI. Sponsors get none. */
export const UI_RESOURCES = [
  { uri: VIEW_URI, name: "charles_view", title: "Charles — your plan", description: DESCRIPTION, mimeType: MCP_APP_MIME },
  { uri: VIEW_URI_CHATGPT, name: "charles_view_chatgpt", title: "Charles — your plan (ChatGPT)", description: DESCRIPTION, mimeType: SKYBRIDGE_MIME },
] as const;

/**
 * The tool `_meta` that makes a host draw the view under that tool's answer.
 * The words ChatGPT shows while the tool runs are short and person-facing.
 */
export function viewToolMeta(invoking: string, invoked: string): Record<string, unknown> {
  return {
    ui: { resourceUri: VIEW_URI },
    "openai/outputTemplate": VIEW_URI_CHATGPT,
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
    // The page's buttons call tools (complete_step, report_outcome, get_current_step).
    "openai/widgetAccessible": true,
  };
}

/** resources/read for a view URI, or null for any other URI. */
export function readUiResource(uri: string): { uri: string; mimeType: string; text: string; _meta: Record<string, unknown> } | null {
  const hit = UI_RESOURCES.find((r) => r.uri === uri);
  if (!hit) return null;
  return {
    uri: hit.uri,
    mimeType: hit.mimeType,
    text: viewHTML(),
    _meta: {
      // Nothing outside the page: no fetches, no fonts, no images from anywhere.
      ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true, permissions: { clipboardWrite: {} } },
      "openai/widgetDescription": DESCRIPTION,
      "openai/widgetPrefersBorder": true,
      "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
    },
  };
}

/**
 * The page. Plain ES5-style script (no build step, no framework), every
 * person-visible string escaped before it is drawn, every link https only
 * and opened through the host.
 */
export function viewHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Charles</title>
<style>
html,body{margin:0;padding:0;background:#ffffff}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#171f1a;-webkit-text-size-adjust:100%}
button{font-family:inherit;font-size:13px;cursor:pointer}
button[disabled]{cursor:default;opacity:0.6}
</style>
</head>
<body>
<div id="root"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:16px;color:#4a5a51">Opening your plan…</td></tr></table></div>
<script>
${VIEW_SCRIPT}
</script>
</body>
</html>`;
}

// The page's script. Kept as a plain string so the HTML is one static file.
const VIEW_SCRIPT = String.raw`(function () {
  "use strict";
  var PALETTE = {
    light: { bg: "#ffffff", card: "#f6f8f7", ink: "#171f1a", ink2: "#4a5a51", muted: "#7a877f", line: "#e1e7e3", leaf: "#1f7a4d", leafText: "#ffffff", soft: "#e9f5ee", red: "#c0392b", amber: "#b7791f", green: "#1f9d55", warnBg: "#fdf5e6" },
    dark:  { bg: "#15201c", card: "#1b2a24", ink: "#f2f5f3", ink2: "#c9d4ce", muted: "#93a39a", line: "#2c3a34", leaf: "#1f9d55", leafText: "#ffffff", soft: "#1d3229", red: "#e06b5e", amber: "#e0a84f", green: "#3cc47a", warnBg: "#2e2817" }
  };
  var state = { data: null, theme: "light", phase: null, note: "", busy: false, doneStep: null, links: [] };
  function col() { return PALETTE[state.theme] || PALETTE.light; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function safeUrl(u) {
    var s = String(u || "").trim();
    return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : null;
  }

  // ── The MCP Apps bridge (JSON-RPC over postMessage) ──
  var nextId = 1;
  var pending = {};
  function post(msg) { try { window.parent.postMessage(msg, "*"); } catch (e) {} }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
      setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error("timeout")); } }, 45000);
    });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }
  window.addEventListener("message", function (ev) {
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id != null && (m.result !== undefined || m.error !== undefined) && pending[m.id]) {
      var p = pending[m.id]; delete pending[m.id];
      if (m.error) p.reject(new Error(m.error.message || "error")); else p.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-result") {
      var sc = m.params && m.params.structuredContent;
      if (sc && typeof sc === "object") { state.data = sc; state.phase = null; state.note = ""; render(); }
    } else if (m.method === "ui/notifications/host-context-changed") {
      if (m.params && (m.params.theme === "dark" || m.params.theme === "light")) { state.theme = m.params.theme; render(); }
    } else if ((m.method === "ui/resource-teardown" || m.method === "ping") && m.id != null) {
      post({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  });

  // ── ChatGPT's window.openai ──
  function fromOpenAI() {
    var oa = window.openai;
    if (!oa) return;
    if (oa.theme === "dark" || oa.theme === "light") state.theme = oa.theme;
    if (oa.toolOutput && typeof oa.toolOutput === "object" && !state.data) state.data = oa.toolOutput;
  }
  window.addEventListener("openai:set_globals", function () {
    var oa = window.openai;
    if (oa && oa.toolOutput && typeof oa.toolOutput === "object" && !state.busy) state.data = oa.toolOutput;
    if (oa && (oa.theme === "dark" || oa.theme === "light")) state.theme = oa.theme;
    render();
  });

  function callTool(name, args) {
    if (window.openai && typeof window.openai.callTool === "function") return Promise.resolve(window.openai.callTool(name, args));
    return request("tools/call", { name: name, arguments: args });
  }
  /** What the person did here, so their AI knows it next turn. */
  function tellModel(text) {
    try {
      if (window.openai && typeof window.openai.setWidgetState === "function") { window.openai.setWidgetState({ last_action: text }); return; }
      request("ui/update-model-context", { content: [{ type: "text", text: text }] }).catch(function () {});
    } catch (e) {}
  }
  function openLink(url) {
    var u = safeUrl(url);
    if (!u) return;
    if (window.openai && typeof window.openai.openExternal === "function") { window.openai.openExternal({ href: u }); return; }
    request("ui/open-link", { url: u }).catch(function () { try { window.open(u, "_blank", "noopener"); } catch (e) {} });
  }

  // ── Drawing (tables and inline hex only: CLAUDE.md rule 8) ──
  function table(inner, extra) { return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;' + (extra || "") + '">' + inner + "</table>"; }
  function row(inner, style) { return '<tr><td style="' + (style || "") + '">' + inner + "</td></tr>"; }
  function label(text) { var c = col(); return '<div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:' + c.muted + ';margin:0 0 4px 0">' + esc(text) + "</div>"; }
  function para(text, color) { return '<div style="color:' + (color || col().ink) + ';margin:0 0 10px 0;white-space:pre-wrap">' + esc(text) + "</div>"; }
  function button(text, action, primary) {
    var c = col();
    var st = primary
      ? "background:" + c.leaf + ";color:" + c.leafText + ";border:1px solid " + c.leaf + ";"
      : "background:" + c.bg + ";color:" + c.ink + ";border:1px solid " + c.line + ";";
    return '<button type="button" data-action="' + esc(action) + '"' + (state.busy ? " disabled" : "") + ' style="' + st + 'border-radius:8px;padding:7px 12px;margin:0 6px 6px 0;font-weight:600">' + esc(text) + "</button>";
  }
  function linkButton(text, url) {
    var u = safeUrl(url);
    if (!u) return "";
    state.links.push(u);
    return button(text, "open:" + (state.links.length - 1), false);
  }
  function list(items, ordered) {
    var c = col();
    var out = "";
    for (var i = 0; i < items.length; i++) {
      out += '<tr><td valign="top" style="width:22px;color:' + c.muted + ';padding:2px 0">' + (ordered ? i + 1 + "." : "•") + '</td><td style="color:' + c.ink2 + ';padding:2px 0">' + esc(items[i]) + "</td></tr>";
    }
    return out ? table(out, "margin:0 0 10px 0") : "";
  }
  function header(kicker, title) {
    var c = col();
    return row(
      (kicker ? '<div style="font-size:12px;color:' + c.muted + ';margin:0 0 2px 0">' + esc(kicker) + "</div>" : "") +
        '<div style="font-size:18px;font-weight:800;color:' + c.ink + ';line-height:1.3">' + esc(title) + "</div>",
      "padding:16px 16px 8px 16px"
    );
  }
  function noteRow() {
    var c = col();
    return state.note ? row('<div style="background:' + c.soft + ";color:" + c.ink + ';border-radius:8px;padding:8px 10px">' + esc(state.note) + "</div>", "padding:0 16px 12px 16px") : "";
  }
  function progressBar(p) {
    var c = col();
    if (!p || !p.total) return "";
    var pct = Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
    var bar = table(
      "<tr>" +
        (pct > 0 ? '<td width="' + pct + '%" style="background:' + c.leaf + ';height:8px;font-size:0;line-height:0">&nbsp;</td>' : "") +
        (pct < 100 ? '<td style="background:' + c.line + ';height:8px;font-size:0;line-height:0">&nbsp;</td>' : "") +
        "</tr>",
      "border-radius:4px;overflow:hidden"
    );
    return bar + '<div style="font-size:12px;color:' + c.muted + ';margin:6px 0 0 0">' + esc(p.done + " of " + p.total + " done" + (p.skipped ? ", " + p.skipped + " skipped" : "")) + "</div>";
  }

  function viewStep(d) {
    var c = col();
    var out = header([d.position, d.part].filter(Boolean).join(" · "), d.title);
    var body = "";
    if (d.what_to_do) body += para(d.what_to_do);
    if (d.why_for_you) body += label("Why this, for you") + para(d.why_for_you, c.ink2);
    if (d.done_when) body += label("Done when") + para(d.done_when, c.ink2);
    if (d.words_ready_to_send) {
      body += label("Ready to send") +
        table(row('<div id="words" style="white-space:pre-wrap;color:' + c.ink + '">' + esc(d.words_ready_to_send) + "</div>", "background:" + c.card + ";border:1px solid " + c.line + ";border-radius:8px;padding:10px 12px"), "margin:0 0 6px 0") +
        button("Copy the words", "copy", false);
    } else if (d.words_to_fill_in) {
      body += label("Words to send, once you fill the blanks") +
        table(row('<div style="white-space:pre-wrap;color:' + c.ink + '">' + esc(d.words_to_fill_in) + "</div>", "background:" + c.warnBg + ";border:1px solid " + c.line + ";border-radius:8px;padding:10px 12px"), "margin:0 0 10px 0");
    }
    if (d.how_to && d.how_to.length) body += label("How to do it") + list(d.how_to, true);
    if (d.tool) {
      var t = d.tool;
      var card = '<div style="font-weight:700;color:' + c.ink + '">' + esc(t.name) + "</div>" +
        (t.cost ? '<div style="color:' + c.ink2 + ';font-size:13px;margin:2px 0 8px 0">' + esc(t.cost) + "</div>" : "") +
        (t.set_up && t.set_up.length ? list(t.set_up, true) : "") +
        (t.ten_minute_action ? '<div style="color:' + c.ink2 + ';font-size:13px;margin:0 0 8px 0"><b>In ten minutes:</b> ' + esc(t.ten_minute_action) + "</div>" : "") +
        linkButton("Open " + t.name, t.url);
      body += label("The tool") + table(row(card, "background:" + c.card + ";border:1px solid " + c.line + ";border-radius:8px;padding:10px 12px"), "margin:0 0 12px 0");
    }
    out += row(body, "padding:0 16px 4px 16px");
    out += noteRow();
    var actions = "";
    if (state.phase === "asked_outcome") {
      actions = '<div style="color:' + c.ink + ';margin:0 0 8px 0;font-weight:600">Has it made any difference yet?</div>' +
        button("Yes, already", "outcome:better", true) + button("Too early to say", "outcome:too_early", false) + button("No change", "outcome:same", false);
    } else if (state.phase === "outcome_done") {
      actions = button("Next step", "next", true);
    } else {
      actions = button("I've done it", "done", true) + button("Send to my phone", "send", false);
    }
    out += row(actions, "padding:0 16px 12px 16px");
    if (d.after_this && !state.phase) out += row('<div style="font-size:12px;color:' + c.muted + '">After this: ' + esc(d.after_this) + "</div>", "padding:0 16px 16px 16px");
    return table(out);
  }

  var MARK = { done: "✓", skipped: "–", open: "○" };
  function viewPlan(d) {
    var c = col();
    var out = header(d.business || "Your 90-day plan", d.goal || d.headline || "Your 90-day plan");
    out += row(progressBar(d.progress), "padding:0 16px 12px 16px");
    var steps = d.steps || [];
    var rows = "";
    var lastPart = null;
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      if (s.part && s.part !== lastPart) {
        rows += '<tr><td colspan="2" style="padding:10px 0 4px 0;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:' + c.muted + '">' + esc(s.part) + "</td></tr>";
        lastPart = s.part;
      }
      var here = d.current_step_id && s.id === d.current_step_id;
      var mark = MARK[s.status] || "○";
      var color = s.status === "done" ? c.muted : c.ink;
      rows += '<tr><td valign="top" style="width:22px;padding:4px 0;color:' + (s.status === "done" ? c.green : c.muted) + '">' + mark + "</td>" +
        '<td style="padding:4px 0;color:' + color + ";" + (s.status === "skipped" ? "text-decoration:line-through;" : "") + (here ? "font-weight:700;" : "") + '">' + esc(s.title) +
        (here ? ' <span style="background:' + c.soft + ";color:" + c.leaf + ';border-radius:10px;padding:1px 8px;font-size:11px;font-weight:700;white-space:nowrap">You’re here</span>' : "") +
        "</td></tr>";
    }
    out += row(table(rows), "padding:0 16px 12px 16px");
    out += noteRow();
    out += row((d.current_step_id ? button("Show the step I'm on", "next", true) : "") + linkButton("Read it online", d.plan_url), "padding:0 16px 16px 16px");
    return table(out);
  }

  var DOT = { red: "#c0392b", amber: "#d68910", green: "#1f9d55" };
  var WORD = { red: "Not sorted", amber: "Getting there", green: "Sorted" };
  function viewMap(d) {
    var c = col();
    var out = header(d.business || "", "Your money map");
    var rows = "";
    var areas = d.map || [];
    for (var i = 0; i < areas.length; i++) {
      var a = areas[i];
      rows += '<tr><td valign="top" style="width:18px;padding:6px 0"><span style="display:inline-block;width:10px;height:10px;border-radius:5px;background:' + (DOT[a.status] || c.muted) + '"></span></td>' +
        '<td style="padding:6px 0;color:' + c.ink + '"><b>' + esc(a.label || a.domain) + '</b> <span style="color:' + c.muted + ';font-size:12px">' + esc(WORD[a.status] || "") + "</span>" +
        (a.note ? '<div style="color:' + c.ink2 + ';font-size:13px">' + esc(a.note) + "</div>" : "") + "</td></tr>";
    }
    out += row(rows ? table(rows) : para("Nothing on the map yet.", c.ink2), "padding:0 16px 16px 16px");
    return table(out);
  }

  function viewMessage(title, text) {
    var c = col();
    return table(header("", title) + row(para(text, c.ink2), "padding:0 16px 16px 16px"));
  }

  function render() {
    var c = col();
    state.links = [];
    document.body.style.background = c.bg;
    document.body.style.color = c.ink;
    var d = state.data;
    var html;
    if (!d) html = table(row('<span style="color:' + c.ink2 + '">Opening your plan…</span>', "padding:16px"));
    else if (d.view === "step") html = viewStep(d);
    else if (d.view === "plan") html = viewPlan(d);
    else if (d.view === "map") html = viewMap(d);
    else if (d.view === "paused") html = viewMessage("Your plan is paused", d.message || "");
    else if (d.view === "done") html = viewMessage("Your plan is done", d.message || "");
    else html = viewMessage("No plan yet", d.message || "");
    document.getElementById("root").innerHTML = html;
    sizeChanged();
  }

  // ── Actions ──
  function act(action) {
    var d = state.data || {};
    if (action === "copy") {
      var text = d.words_ready_to_send || "";
      var ok = function () { state.note = "Copied. Paste it into WhatsApp."; render(); };
      var fallback = function () {
        var el = document.getElementById("words");
        if (el && window.getSelection) { var r = document.createRange(); r.selectNodeContents(el); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
        state.note = "Selected — copy it from here."; sizeChanged();
      };
      try { navigator.clipboard.writeText(text).then(ok, fallback); } catch (e) { fallback(); }
      return;
    }
    if (action.indexOf("open:") === 0) { openLink(state.links[Number(action.slice(5))]); return; }
    if (state.busy) return;
    var run = function (name, args, then) {
      state.busy = true; state.note = ""; render();
      callTool(name, args).then(function (res) {
        state.busy = false;
        var r = res || {};
        if (r.isError) { state.note = "That didn't go through. Try again, or tell me in the chat."; render(); return; }
        then(r.structuredContent || null, r);
      }, function () { state.busy = false; state.note = "That didn't go through. Try again, or tell me in the chat."; render(); });
    };
    if (action === "done" && d.view === "step" && d.id) {
      run("complete_step", { step_id: String(d.id) }, function () {
        state.doneStep = { id: String(d.id), title: d.title };
        state.phase = "asked_outcome";
        tellModel('The person marked "' + d.title + '" done in the plan view.');
        render();
      });
      return;
    }
    if (action.indexOf("outcome:") === 0 && state.doneStep) {
      var effect = action.slice(8);
      var done = state.doneStep;
      run("report_outcome", { step_id: done.id, effect: effect }, function (_sc, r) {
        var text = r && r.content && r.content[0] && r.content[0].text;
        state.phase = "outcome_done";
        state.note = text || "Noted.";
        tellModel('The person said "' + done.title + '" ' + (effect === "better" ? "has made a difference" : effect === "same" ? "has made no difference yet" : "is too early to judge") + ".");
        render();
      });
      return;
    }
    if (action === "next") {
      run("get_current_step", {}, function (sc) { if (sc) { state.data = sc; state.phase = null; state.doneStep = null; } render(); });
      return;
    }
    if (action === "send" && d.view === "step") {
      run("get_current_step", { send_to_whatsapp: true }, function (sc) {
        state.note = sc && sc.sent_to_whatsapp === "sent" ? "Sent to your WhatsApp." : "WhatsApp only lets Charles message you within 24 hours of your last message there. Send Charles any message on WhatsApp, then try again.";
        render();
      });
    }
  }
  document.addEventListener("click", function (ev) {
    var el = ev.target;
    while (el && el !== document && !(el.getAttribute && el.getAttribute("data-action"))) el = el.parentNode;
    if (el && el.getAttribute && el.getAttribute("data-action") && !el.disabled) act(el.getAttribute("data-action"));
  });

  // ── Size: the host sizes the frame to the page ──
  var lastH = 0;
  function sizeChanged() {
    var h = Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 0);
    var w = Math.ceil(document.documentElement.scrollWidth || 0);
    if (h && h !== lastH) { lastH = h; notify("ui/notifications/size-changed", { width: w, height: h }); }
  }
  if (typeof ResizeObserver === "function") { try { new ResizeObserver(sizeChanged).observe(document.body); } catch (e) {} }

  // ── Start ──
  fromOpenAI();
  render();
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    clientInfo: { name: "charles-view", version: "1.0.0" },
    appInfo: { name: "charles-view", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
    capabilities: {}
  }).then(function (r) {
    var hc = (r && r.hostContext) || {};
    if (hc.theme === "dark" || hc.theme === "light") state.theme = hc.theme;
    notify("ui/notifications/initialized", {});
    render();
  }, function () {});
})();`;
