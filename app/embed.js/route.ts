import { baseUrl, EMBED_SIZE } from "@/lib/front-door";

// GET /embed.js
//
// One script tag, then <beliefatlas-question question="12"></beliefatlas-question> anywhere on a
// page. It draws the question in an iframe from our site (so its look is ours and its votes
// go through our engine) and grows the frame to fit.
//
//   <script src="https://beliefatlas.example/embed.js" async></script>
//   <beliefatlas-question question="12"></beliefatlas-question>
export function GET() {
  const base = baseUrl();
  const js = `(function(){
  if (window.customElements && customElements.get("beliefatlas-question")) return;
  var BASE = ${JSON.stringify(base)}, ORIGIN = new URL(BASE).origin;
  class BeliefAtlasQuestion extends HTMLElement {
    connectedCallback() {
      if (this.firstChild) return;
      var id = parseInt(this.getAttribute("question") || "", 10);
      if (!(id > 0)) return;
      var f = document.createElement("iframe");
      f.src = BASE + "/embed/" + id + "?at=" + encodeURIComponent(location.hostname);
      f.title = this.getAttribute("title") || "True or false question";
      f.width = ${EMBED_SIZE.width}; f.height = ${EMBED_SIZE.height};
      f.loading = "lazy";
      f.allow = "web-share; storage-access";
      f.style.cssText = "border:0;width:100%;max-width:" + ${EMBED_SIZE.width} + "px;display:block";
      this.appendChild(f);
      window.addEventListener("message", function (e) {
        if (e.origin !== ORIGIN || e.source !== f.contentWindow || !e.data || e.data.type !== "beliefatlas:height") return;
        var h = Math.min(Math.max(parseInt(e.data.h, 10) || 0, 120), 900);
        f.height = h;
      });
    }
  }
  customElements.define("beliefatlas-question", BeliefAtlasQuestion);
})();
`;
  return new Response(js, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
