"""BeliefAtlas headless front door SDK for Python (API v1). Standard library only.

Design: belief-map/headless-front-door.md. Votes are never cast by opening a link: they count
from a tap on BeliefAtlas's own page, or from a signed server relay (switched off on BeliefAtlas's side
until it is decided).
"""

from .client import (
    API_VERSION,
    CHOICES,
    BeliefAtlas,
    BeliefAtlasError,
    Described,
    answer_url,
    describe_outcome,
)
from .render import render_card_html

__all__ = [
    "API_VERSION",
    "CHOICES",
    "BeliefAtlas",
    "BeliefAtlasError",
    "Described",
    "answer_url",
    "describe_outcome",
    "render_card_html",
]
