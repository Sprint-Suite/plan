# Debate: Code review: board card layout, fixed points column (commit af1dc41, branch fix/card-fixed-points-column)

- Id: 2026-11-10-code-review-board-card-layout-fixed-points-column
- Opened: 2026-11-10T12:00:15.595Z
- Model: gpt-6.1-sol
- Max rounds: 3

## Round 1/3 — Claude

A small UI stage, requested by David from a screenshot. On board story cards the order was title, points, D badges, [stretch chip], stretch toggle, return. The points carried margin-left:auto, so on any card with a D badge or a stretch chip the points (and that marker) were pushed left. The points column moved from card to card.

Change (public/js/backlog.js storyCard, public/css/plan.css): the order is now title (flex:1; min-width:0), D badges, stretch chip (placed cards with stretch only, same condition as before), points (min-width:2ch, right-aligned, margin-left:auto removed), then the toggle and return. Classes and data attributes are unchanged. Connectors anchor to the card's bounding rect (connectors.js:132), not to the badge. Backlog cards get the same order.

Verified: npm test 307/307. Headless Chromium on a seeded sprint with five cards (two with D1, one with a stretch chip, two plain, points 3/5/5/3/13): the points' right edge measured 647px on every card, markers sat left of the points, and the screenshot looks right.

Check: anything in drag.js/main.js/connectors.js/tests that depends on child order or on .bl-story-pts being the auto-margin element; a11y or reading-order regressions; any long-title overflow issue from flex:1/min-width:0.

## Round 1/3 — ChatGPT: OBJECT

The reordering is sound, but public/css/plan.css:575 needs an overflow rule. Adding flex:1 and min-width:0 allows the title box to shrink below its longest word, while text still has visible overflow and no emergency wrapping. A long identifier or URL can therefore paint across the badges, points and controls. Such titles are valid (public/js/validate.js:58), and the shared renderer also affects the 280px backlog. Previously the title’s automatic minimum width resisted this shrinkage; this change introduces overlapping content.

Keep the new order and add overflow-wrap:anywhere to .bl-story-title, then verify long unbroken titles on backlog and placed cards, including badges plus stretch.

I independently confirmed that drag.js uses data attributes/closest(), main.js:409 delegates through data-act, and connectors.js:131–135 anchors to the card rectangle. No child-order dependency or new keyboard-order regression was found; button labels and relative order remain unchanged.

Syntax, diff whitespace and focused selector/move/stretch checks pass. Full npm test could not reproduce 307/307 under this sandbox: failures include EROFS creating temporary databases and EPERM binding sockets. Those are environment limitations, not evidence against this commit.

