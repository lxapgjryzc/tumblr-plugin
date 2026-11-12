# Tumblr Studio bug report — 2026-11-10

Status: **Fixed 2026-11-12 (see Resolution at the end).** Originally recorded at the user's request for a later Claude repair session. This handoff records one additional issue; no application fix or live reproduction was performed.

## BUG-20261110-01 — Paragraph toolbar obscures the first line of text

### Evidence and observed behavior

- [Original screenshot: paragraph toolbar overlapping text](bug-reports/2026-11-10/01-composer-toolbar-overlap.png). Unmodified copy of the user's attachment, originally `C:\Users\Admin\Pictures\Screenshots\Screenshot 2026-11-10 123532.png` (filename timestamp: November 10, 12:35:32 local time).
- The dark composer shows two populated English paragraphs, empty text placeholders above, and an image block below. The lower paragraph has a focus outline and a caret at the end of its last line.
- Each populated paragraph has a toolbar at its upper right containing `↑`, `↓`, the `正文` style selector, and `×`. Both toolbars are visible in the screenshot and cover the right-hand portion of their paragraph's first line.
- Text runs behind the controls instead of remaining fully readable. This obstructs reading while editing; whether pointer placement or selection is also blocked needs reproduction.
- The attachment is a 982 × 558 image of part of the editor. The full browser viewport, browser zoom, exact frontend build, hover position and preceding interaction sequence are unknown; do not treat the screenshot dimensions as the viewport or its right edge as proof of an additional clipping bug.

### Expected behavior / acceptance

- When a paragraph toolbar is visible, every line of that paragraph remains readable and editable. Give the controls sufficient space or position them outside the editable text area; the exact layout is an implementation choice.
- Check both a focused paragraph and a hovered neighboring paragraph, including both toolbars being visible at once. Controls must not cover either paragraph or adjacent blocks.
- Check long single-line and wrapped text, English and Chinese, narrower editor widths, and browser zoom. The toolbar must remain usable without covering text, the caret or a selection.
- Verify typing, selecting text, switching paragraph focus, changing paragraph style, moving blocks and deleting a block. Toolbar appearance/disappearance must not disrupt editing or unexpectedly move the caret; the layout change must preserve document text and block order.
- Capture visual before/after evidence in the isolated test environment. Record the viewport and zoom used, and any conditions needed to reproduce the overlap.

### Starting points for Claude (not a confirmed runtime diagnosis)

- `desktop/src/renderer/style.css`: `.unit`, `.unit-tools`, `.unit:hover .unit-tools`, `.unit:focus-within .unit-tools`, and `.text-block`. In the source inspected for this report, the toolbar is absolutely positioned at `right: -6px; top: -2px; z-index: 2`, and text has `padding: 6px 10px`. Inspect how space is reserved when these controls become visible.
- `desktop/src/renderer/pages/write.js`: `unitTools()` and `textEl()` place the toolbar and editable text in the same `.unit.text-unit` container. Check shared toolbar behavior for other block types if changing the common styles.
- The latest available diagnostic file was `%APPDATA%\Tumblr Studio\logs\diag-2026-11-09.log`; its last events were at November 9, 18:30:59 local time, before this screenshot. Its tail was read, no `user.note` entry was found in that file, and no `diagnostics-*.txt` export was found in the log directory. This provides no contemporaneous explanation of the layout issue; the screenshot is the primary evidence.

Keep this issue separate from the three items in [the November 8 report](BUG_REPORT_2026-11-08.md). Follow `CLAUDE.md` for isolated test-environment reproduction when the repair is requested.

## Resolution (2026-11-12, Claude)

Cause confirmed in `style.css`: `.unit-tools` was absolutely positioned over the block's top-right corner with no space reserved, and while hidden (`opacity: 0`) it still took clicks. Fix: every `.unit` reserves an 18px strip above its content; the toolbar sits in that strip and the gap before the block (`top: -10px`, compact 22px controls, `z-index` above the inserter strip) and is `visibility: hidden` when not shown, so it takes no clicks. Showing it moves nothing. Applies to all block types.

Visual check (Electron `STUDIO_SNAP`, `STUDIO_FAKE=1`, scratch data folder, zoom 1) at 1400×900 and 1000×700: one focused paragraph plus two forced-visible neighbouring toolbars, long English and wrapped Chinese text; a script check found no toolbar intersecting any text block. See [after 1400×900](bug-reports/2026-11-10/02-after-fix-1400x900.png) and [after 1000×700](bug-reports/2026-11-10/03-after-fix-1000x700.png). Not checked: browser zoom other than 100% and real pointer interaction (typing, selecting, moving or deleting blocks); the DOM and handlers are unchanged.
