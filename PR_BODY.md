## Summary

Tag/fragment autocomplete in the prompt editor got in the way of typing:

- The first suggestion was pre-selected, so Enter inserted it instead of starting a new line.
- Ctrl+Z could not undo a completion.
- A list left open after the caret moved could delete or duplicate text.

This PR fixes those problems. It also makes the list usable with a screen reader and without relying on colour.

## Changes

### Typing and undo (`f60a2fc`, `9283a6f`)

- **Selection.** Nothing is selected when the list opens.
  - Enter inserts only an item picked with ↑/↓ or the mouse. Otherwise Enter is a plain newline and the list closes.
  - Tab inserts the picked item, or the first one if nothing is picked.
- **IME.** Keys are ignored while an IME is composing, so Korean input is not broken by Enter or the arrow keys.
- **Stale list.** The list closes as soon as the caret leaves the token: a click, arrow keys, Home/End, or a range selection. `complete()` checks the token again before writing.
- **Undo.** Insertion goes through `execCommand('insertText')`.
  - The first Ctrl+Z restores the text from before the completion.
  - Further Ctrl+Z presses keep walking back through the earlier typing history.
- **Mouse.** Hovering moves the selection. This listens to `mousemove`, not `mouseenter`, so a list that opens under a resting pointer does not select anything.
- **Stale pick.** A pick made with the arrows is dropped as soon as the input changes. Before this, pressing Enter in the ~90 ms before new results arrived inserted the previous list's item.
- **Tests.** The key handling and caret checks moved into pure functions in `lib/autocomplete.ts`, covered by `tests/autocomplete.test.ts`.

### Accessibility (`7eba217`, `08307dc`)

- **ARIA.**
  - The popup is a `listbox` of `option`s.
  - The textarea keeps focus. It points at the list with `aria-autocomplete="list"` and `aria-controls`, and follows ↑/↓ with `aria-activedescendant`.
  - A polite live region announces how many suggestions there are and what was inserted.
- **Option names.** Each option has a spoken name: tag, kind, post count. Fragments are announced as fragments.
- **Post counts.** Spoken counts use the UI language's own units (`Intl` compact): 119만, 119万, 1.2M. Screen readers read "1.2M" letter by letter otherwise. The visible count is unchanged.
- **Not colour alone (WCAG 1.4.1).**
  - The tag kind is also written as text: Artist / Character / Series / Meta. General tags, which are most of them, are labelled for screen readers only.
  - The item Tab would insert shows a `Tab` key hint, not just the accent line.
- **Contrast (WCAG 1.4.3).** Post counts use `muted` instead of `faint`. `faint` is 3.8:1 on the light theme's selection background, below 4.5:1 for small text. The generated theme presets already guarantee `muted` ≥ 4.5:1 on `surface-2`, and `theme-contrast.test.ts` checks this.
- **Placement.** The popup is positioned from its measured size instead of a 27 px-per-item estimate.
  - If it does not fit below the caret, it flips above.
  - If it fits on neither side, it takes the roomier side, shrinks, and scrolls, keeping the picked option in view. Before, it was clamped over the caret line.

### New i18n keys (ko / en / zh-CN)

- `ui.suggestions`
- `ui.valueSuggestionsUpDownToChooseTabToInsert`
- `ui.insertedValue`
- `ui.tagTypeArtist`, `ui.tagTypeCharacter`, `ui.tagTypeCopyright`, `ui.tagTypeMeta`, `ui.tagTypeGeneral`
- `ui.valuePosts`

## Verification

- `pnpm typecheck`: clean.
- `npx vitest run`: 1575 / 1575 pass. This includes the i18n source checks and the new autocomplete tests.
- ESLint on the changed files: no errors.
- `scripts/verify-prompt-autocomplete.mjs`: 12 / 12 pass. It drives real Chromium against `pnpm dev:web` and is not wired into CI. It covers:
  - Tab plus a double Ctrl+Z
  - Enter with nothing picked
  - Picking with ↓↓ then Enter
  - Clicking elsewhere, Home/←, and range selection, all of which close the list
  - Typing on after a pick, then Enter immediately
  - Completing before an existing comma
  - Hover and click
  - Fragment completion plus Ctrl+Z
  - ARIA wiring
  - Popup placement at window heights of 900, 560, and 420 px

## Not verified

- Not tried with a real screen reader (NVDA or VoiceOver). Only the DOM attributes and the live-region text were checked.
- Not tried in the packaged Electron build. Checks ran in the browser runtime only.

## How to test

1. Type `blue h` in a prompt field.
2. Press Enter. It should start a new line.
3. Type again, then press ↓ and Enter. The picked tag should be inserted.
4. Press Tab, then Ctrl+Z. The text should go back to `blue h`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01A2c6Pd5uR9BCSXPkWDQTWY
