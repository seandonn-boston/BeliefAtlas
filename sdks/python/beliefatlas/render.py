"""Drawing a card as plain HTML for server-rendered pages (Django, Flask, Wagtail, Jinja)."""

from __future__ import annotations

from html import escape
from typing import Any, Mapping


def render_card_html(card: Mapping[str, Any], *, heading_level: int = 3, new_tab: bool = True) -> str:
    """The question and one link per choice to BeliefAtlas's vote page, unstyled; style the
    ``beliefatlas-*`` classes yourself. Every value is escaped. Opening a link never votes."""
    level = heading_level if heading_level in (2, 3, 4) else 3
    target = ' target="_blank" rel="noopener"' if new_tab else ""
    items = "".join(
        f'<li><a class="beliefatlas-choice beliefatlas-{escape(str(c["value"]))}" href="{escape(c["answerUrl"])}"{target}>'
        f'{escape(str(c["label"]))}</a></li>'
        for c in card.get("choices", [])
        if c.get("answerUrl")
    )
    if card.get("status") == "active" and items:
        body = f'<ul class="beliefatlas-choices">{items}</ul>'
    else:
        body = '<p class="beliefatlas-closed">This question is closed to new answers.</p>'
    return (
        f'<section class="beliefatlas-card" data-question="{int(card["id"])}">'
        f'<h{level} class="beliefatlas-text" lang="{escape(str(card.get("lang", "en")))}">{escape(str(card["text"]))}</h{level}>'
        f"{body}</section>"
    )
