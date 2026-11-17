# @beliefatlas/sdk (JavaScript / TypeScript)

Not published. Switched off until the deployment sets `HEADLESS_ENABLED=true`.
Design: `belief-map/headless-front-door.md`. Contract: `../contract/v1.json`, `../openapi.yaml`.

```ts
import { BeliefAtlas, answer, renderCardHtml } from "@beliefatlas/sdk";

const cm = new BeliefAtlas({ baseUrl: "https://beliefatlas.example", placement: "pl-xxxxxxxxxxxx", origin: location.origin });
const { questions } = await cm.placement();          // cards, in order, no split
el.innerHTML = renderCardHtml(questions[0]);          // escaped; each choice links to BeliefAtlas's vote page

// Or draw your own buttons and open the hosted vote page on a tap:
const result = await answer(questions[0], "true");    // counted | skipped | closed | blocked
if (result.status === "counted") showSplit(await cm.split(questions[0].id));
```

- A tap never votes by itself: the person confirms on BeliefAtlas's own page, signed in as themselves.
- `answer()` trusts only a message from BeliefAtlas's origin, from the window it opened, about that question. The message carries no answer and no handle.
- `relayVote()` is server only, needs a credential, and is switched off; no real credentials exist yet.

Tests: `npm test` at the repo root runs `tests/headless-sdk.test.ts` against the real route handlers.
