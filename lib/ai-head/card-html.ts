// The BeliefAtlas question card that an assistant's chat app draws in a sandboxed frame (MCP Apps,
// resource ui://beliefatlas/question-card). It loads nothing from anywhere: no outside scripts,
// fonts, images or requests. It talks only to the chat app, over postMessage (JSON-RPC 2.0).
//
// What it does:
//   1. ui/initialize, then ui/notifications/initialized.
//   2. Waits for ui/notifications/tool-result from show_question: the card in structuredContent,
//      the one-use card token in _meta (neither goes into the model's context).
//   3. Draws the question as text (never HTML) and, if answering is on for this person, the
//      True / False / Don't know / Skip buttons.
//   4. On a tap, calls submit_answer (a tool only the card can call; the model can't see it).
//   5. Shows the outcome, then the live split from get_results, with the notice.
//   6. Tells the assistant what they picked with ui/update-model-context, unless the person
//      ticked "Keep my answer from Claude".

export const CARD_URI = "ui://beliefatlas/question-card";
export const CARD_MIME = "text/html;profile=mcp-app";
export const APPS_PROTOCOL = "2026-01-26";

export function cardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BeliefAtlas question</title>
<style>
  :root { --bg: #ffffff; --fg: #111111; --muted: #5b5b5b; --line: #d9d9d9; --accent: #1f5eff; --chip: #f3f4f6; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #000000; --fg: #f2f2f2; --muted: #a3a3a3; --line: #2b2b2b; --accent: #6f95ff; --chip: #141414; } }
  :root[data-theme="dark"] { --bg: #000000; --fg: #f2f2f2; --muted: #a3a3a3; --line: #2b2b2b; --accent: #6f95ff; --chip: #141414; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px 16px; background: var(--bg); color: var(--fg);
         font: 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .brand { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin: 0 0 6px; }
  .q { font-size: 17px; font-weight: 600; margin: 0 0 12px; }
  .choices { display: flex; flex-wrap: wrap; gap: 8px; }
  button { font: inherit; padding: 8px 14px; border-radius: 999px; border: 1px solid var(--line);
           background: var(--chip); color: var(--fg); cursor: pointer; min-height: 40px; }
  button.picked { border-color: var(--accent); outline: 2px solid var(--accent); }
  button:disabled { opacity: .55; cursor: default; }
  .share { display: flex; gap: 6px; align-items: center; margin: 10px 0 0; font-size: 13px; color: var(--muted); }
  .status { margin: 10px 0 0; min-height: 1em; }
  .bars { margin: 10px 0 0; display: grid; gap: 4px; }
  .bar { display: grid; grid-template-columns: 90px 1fr 48px; gap: 8px; align-items: center; font-size: 13px; }
  .track { height: 8px; background: var(--chip); border-radius: 4px; overflow: hidden; }
  .fill { height: 100%; background: var(--accent); }
  .notice, .meta { font-size: 12px; color: var(--muted); margin: 8px 0 0; }
</style>
</head>
<body>
<p class="brand">BeliefAtlas</p>
<p class="q" id="q">Loading question…</p>
<div class="choices" id="choices"></div>
<label class="share" id="shareRow" hidden><input type="checkbox" id="keep"> Keep my answer from Claude</label>
<p class="meta" id="shareNote" hidden>Claude will see what you pick. Only your own tap counts; Claude can't answer for you.</p>
<p class="status" id="status" role="status" aria-live="polite"></p>
<div class="bars" id="bars" hidden></div>
<p class="meta" id="size"></p>
<p class="notice" id="notice"></p>
<script>
(function () {
  "use strict";
  var nextId = 1, pending = {}, card = null, token = null, busy = false;
  var $ = function (id) { return document.getElementById(id); };
  function send(msg) { window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    var id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function text(el, value) { el.textContent = value == null ? "" : String(value); }
  function structured(result) { return (result && result.structuredContent) || {}; }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id != null && pending[msg.id] && (msg.result !== undefined || msg.error !== undefined)) {
      var p = pending[msg.id]; delete pending[msg.id];
      if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-result") showCard(msg.params || {});
    if (msg.method === "ui/notifications/host-context-changed") theme(msg.params || {});
  });

  function theme(ctx) {
    if (ctx && (ctx.theme === "dark" || ctx.theme === "light")) document.documentElement.setAttribute("data-theme", ctx.theme);
  }

  function showCard(result) {
    var data = structured(result);
    if (!data.card) return;
    card = data.card;
    token = (result._meta && result._meta["beliefatlas/cardToken"]) || null;
    document.documentElement.lang = card.lang || "en";
    text($("q"), card.text);
    text($("notice"), card.notice);
    var box = $("choices");
    box.textContent = "";
    if (card.canAnswer && token) {
      card.choices.forEach(function (c) {
        var b = document.createElement("button");
        b.type = "button";
        text(b, c.label);
        b.addEventListener("click", function () { answer(c.value, b); });
        box.appendChild(b);
      });
      $("shareRow").hidden = false;
      $("shareNote").hidden = false;
    } else if (card.whyNot === "not_linked") {
      text($("status"), "Link your BeliefAtlas account to Claude to answer here.");
    } else if (card.whyNot === "closed") {
      text($("status"), "This question is closed to new answers.");
      loadResults();
    } else {
      text($("status"), "Answering in chat isn't switched on yet.");
    }
  }

  function answer(value, button) {
    if (busy || !token) return;
    busy = true;
    var share = !$("keep").checked;
    Array.prototype.forEach.call($("choices").children, function (b) { b.disabled = true; });
    button.classList.add("picked");
    text($("status"), "Sending your answer…");
    request("tools/call", { name: "submit_answer", arguments: { cardToken: token, value: value } })
      .then(function (result) {
        token = null;
        var out = structured(result);
        text($("status"), out.message || "Done.");
        if (out.counted || out.outcome === "skipped") {
          if (share) {
            request("ui/update-model-context", { content: [{ type: "text", text: out.forAssistant }] }).catch(function () {});
          }
          if (out.counted) loadResults();
        } else if (out.outcome === "needs_consent" && out.linkUrl) {
          var b = document.createElement("button");
          b.type = "button";
          text(b, "Agree to answering in BeliefAtlas");
          b.addEventListener("click", function () { request("ui/open-link", { url: out.linkUrl }).catch(function () {}); });
          $("choices").appendChild(b);
        }
      })
      .catch(function () {
        text($("status"), "That didn't go through. Nothing was counted.");
        busy = false;
        Array.prototype.forEach.call($("choices").children, function (b) { b.disabled = false; b.classList.remove("picked"); });
      });
  }

  function loadResults() {
    if (!card) return;
    request("tools/call", { name: "get_results", arguments: { id: card.id } }).then(function (result) {
      var r = structured(result).results;
      if (!r) return;
      if (!r.quotable) { text($("size"), "Not enough answers yet to show a split."); return; }
      var bars = $("bars");
      bars.textContent = "";
      [["true", "True"], ["false", "False"], ["unsure", "Don't know"]].forEach(function (pair) {
        var row = document.createElement("div"); row.className = "bar";
        var label = document.createElement("span"); text(label, pair[1]);
        var track = document.createElement("span"); track.className = "track";
        var fill = document.createElement("span"); fill.className = "fill"; fill.style.display = "block";
        fill.style.width = Math.max(0, Math.min(100, Number(r.split[pair[0]]) || 0)) + "%";
        track.appendChild(fill);
        var pct = document.createElement("span"); text(pct, r.split[pair[0]] + "%");
        row.appendChild(label); row.appendChild(track); row.appendChild(pct);
        bars.appendChild(row);
      });
      bars.hidden = false;
      text($("size"), r.size + ", as of " + new Date(r.asOf).toLocaleTimeString() + (r.sample ? ". " + r.sample.note : ""));
    }).catch(function () {});
  }

  request("ui/initialize", {
    protocolVersion: "${APPS_PROTOCOL}",
    appInfo: { name: "BeliefAtlas question card", version: "0.1.0" },
    appCapabilities: {}
  }).then(function (res) {
    theme(res && res.hostContext);
    notify("ui/notifications/initialized");
  }).catch(function () { notify("ui/notifications/initialized"); });
})();
</script>
</body>
</html>`;
}
