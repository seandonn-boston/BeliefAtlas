import { getAccount } from "@/lib/auth";
import { baseUrl, brandName, cleanPlacement, voteUrl } from "@/lib/front-door";
import { getQuestion } from "@/lib/questions";
import { myVotes } from "@/lib/votes";
import { UNOFFICIAL_NOTICE } from "@/lib/legal";

// GET /embed/:id  (the page inside an embed's iframe)
//
// Plain HTML, no framework script, so it is light on someone else's page. The answer buttons
// open the one-tap page in a small popup with the answer highlighted; one tap there counts it,
// the popup tells this frame, and the frame shows "Counted for @handle" in place. Browsers
// that block popups (or scripts) follow the same link in a new tab.
//
// Why not count the tap inside the frame: the session cookie is SameSite=Lax, so it is not
// sent to a frame on another site. Counting in-frame needs that cookie changed to
// SameSite=None plus the Storage Access API in Safari and Firefox; that is a separate,
// deliberate security change.

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const LABEL: Record<string, string> = { true: "True", false: "False", unsure: "Don't know" };

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const questionId = Number((await params).id);
  const question = Number.isInteger(questionId) && questionId > 0 ? await getQuestion(questionId) : null;
  if (!question) return new Response("Not found", { status: 404 });

  const at = cleanPlacement(new URL(request.url).searchParams.get("at"));
  const account = await getAccount(); // only present where the browser sends our cookie to frames
  const mine = account ? (await myVotes(account.id, [questionId])).get(questionId) : undefined;
  const origin = new URL(baseUrl()).origin;
  const link = (pick: string) => {
    const url = new URL(voteUrl(questionId, { via: "embed", pick: pick as "true" | "false" | "unsure" | "skip" }));
    if (at) url.searchParams.set("at", at);
    url.searchParams.set("popup", "1");
    return url.toString();
  };
  const shareUrl = voteUrl(questionId, { via: "share" });
  const closed = question.status !== "active";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(question.text)}</title>
<style>
*{box-sizing:border-box}html,body{margin:0;background:#000;color:#eef1f6;font:16px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.c{padding:16px;display:grid;gap:12px}.b{font-size:13px;font-weight:700;color:#99a1ae;text-decoration:none}
h1{margin:0;font-size:22px;line-height:1.15;font-weight:800}
.v{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.v a{display:flex;align-items:center;justify-content:center;height:48px;border:1px solid #23262c;border-radius:8px;color:#eef1f6;text-decoration:none;font-weight:800;font-size:17px}
.v .t{box-shadow:inset 0 -3px 0 #2196e8}.v .f{box-shadow:inset 0 -3px 0 #dd6f17}
.v .u{grid-column:1/-1;height:42px;box-shadow:inset 0 -3px 0 #6b7480}
.v .p{grid-column:1/-1;height:36px;color:#99a1ae;font-weight:600;font-size:15px;border-color:#16181c}
.done{margin:0}.chip{display:inline-block;padding:0 9px;border-radius:999px;color:#000;font-weight:800}
.chip.true{background:#2196e8}.chip.false{background:#dd6f17}.chip.unsure{background:#6b7480;color:#fff}
.n{margin:0;font-size:12px;font-weight:600;color:#99a1ae}
.row{display:flex;gap:14px;align-items:center;font-size:14px;color:#99a1ae}.row a,.row button{color:#eef1f6}
button{font:inherit;background:none;border:0;padding:0;text-decoration:underline;cursor:pointer}
</style></head><body>
<div class="c" id="c">
<a class="b" href="${esc(baseUrl())}" target="_blank" rel="noopener">${esc(brandName())}</a>
<p class="n">${esc(UNOFFICIAL_NOTICE)}</p>
<h1>${esc(question.text)}</h1>
<p class="done" id="done"${mine ? "" : " hidden"}>${mine ? `<span class="chip ${mine.value}">${LABEL[mine.value]}</span> counted for @${esc(account!.username)}` : ""}</p>
${closed ? '<p class="row">This question no longer takes new votes.</p>' : `<div class="v" id="v"${mine ? " hidden" : ""}>
<a class="t" href="${esc(link("true"))}" target="_blank" rel="opener" data-pick="true">True</a>
<a class="f" href="${esc(link("false"))}" target="_blank" rel="opener" data-pick="false">False</a>
<a class="u" href="${esc(link("unsure"))}" target="_blank" rel="opener" data-pick="unsure">Don&#39;t know</a>
<a class="p" href="${esc(link("skip"))}" target="_blank" rel="opener" data-pick="skip">Skip</a>
</div>`}
<div class="row"><a href="${esc(`${baseUrl()}/q/${questionId}`)}" target="_blank" rel="noopener">See results</a><button type="button" id="s">Share</button></div>
</div>
<script>
(function(){
  var ORIGIN=${JSON.stringify(origin)}, SHARE=${JSON.stringify(shareUrl)}, TEXT=${JSON.stringify(question.text)};
  var LABEL={"true":"True","false":"False","unsure":"Don't know"};
  function height(){parent.postMessage({type:"beliefatlas:height",id:${questionId},h:document.documentElement.scrollHeight},"*")}
  document.querySelectorAll("[data-pick]").forEach(function(a){
    a.addEventListener("click",function(e){
      var w=window.open(a.href,"beliefatlas_vote","popup,width=480,height=640");
      if(w){e.preventDefault()}
    });
  });
  window.addEventListener("message",function(e){
    if(e.origin!==ORIGIN||!e.data||e.data.type!=="beliefatlas:voted"||e.data.questionId!==${questionId})return;
    var d=document.getElementById("done"),v=document.getElementById("v");
    d.textContent="";var c=document.createElement("span");c.className="chip "+e.data.value;c.textContent=LABEL[e.data.value]||"";
    d.appendChild(c);d.appendChild(document.createTextNode(" counted for @"+e.data.handle));d.hidden=false;if(v)v.hidden=true;height();
  });
  document.getElementById("s").addEventListener("click",function(){
    if(navigator.share){navigator.share({title:TEXT,text:TEXT+" True or false?",url:SHARE}).catch(function(){})}
    else{window.open(SHARE,"_blank","noopener")}
  });
  height();window.addEventListener("resize",height);
})();
</script>
</body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Any site may frame this page; nothing else on the site can be framed.
      "Content-Security-Policy": "frame-ancestors *",
      "Cache-Control": "private, no-store",
    },
  });
}
