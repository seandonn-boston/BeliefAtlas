# beliefatlas (Python)

Not published. Standard library only. Switched off until the deployment sets `HEADLESS_ENABLED=true`.
Design: `belief-map/headless-front-door.md`. Contract: `../contract/v1.json`, `../openapi.yaml`.

```python
from beliefatlas import BeliefAtlas, render_card_html

cm = BeliefAtlas("https://beliefatlas.example", placement="pl-xxxxxxxxxxxx", lang="es")
cards = cm.placement()["questions"]
html = render_card_html(cards[0])   # escaped; each choice links to BeliefAtlas's vote page
```

For a CMS (Django, Wagtail, Plone) or a server-rendered checkout page: fetch the card on the
server, render it, and let the person's tap open BeliefAtlas's vote page.

`relay_vote()` and `results()` are server to server and need an org key (`cm_live_...`) with the `relay` or `results` scope. BeliefAtlas's keys are built and switched off until it turns them on.

Tests: `python3 -I -m unittest discover -s tests -t .` from this folder. Set
`BELIEFATLAS_LIVE_BASE_URL` and `BELIEFATLAS_LIVE_PLACEMENT` to also run them against a running dev server.
