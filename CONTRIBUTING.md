# Contributing translations

NAIS3 uses typed, stable message IDs shared by Electron and the browser renderer.
Translations are bundled with the application and work offline.

## Correct an existing translation

Edit the value in the relevant catalog under `src/shared/i18n/`:

| Language | Catalog            |
| -------- | ------------------ |
| 한국어   | `catalog-ko.ts`    |
| English  | `catalog-en.ts`    |
| 简体中文 | `catalog-zh-CN.ts` |

Keep message IDs unchanged when correcting wording. For example, the ID
`ui.settings` stays the same whether its value is `설정`, `Settings`, or `设置`.
IDs are identifiers, not text shown to users. Existing IDs must not be regenerated
from revised Korean or English wording.

Preserve the positional placeholders `{0}`, `{1}`, etc. You may change their order
to match your language's grammar. The existing English catalog also uses the
two-form plural syntax `{0|image|images}` (singular when argument 0 is 1).
Korean and Chinese normally use `{0}` without a plural expression. The current
formatter does not interpret ICU message syntax; languages requiring additional
plural categories need an explicit formatter extension and tests.

The catalog files are TypeScript objects: preserve quote escaping and `\n` line
breaks, and keep the `satisfies MessageCatalog` declaration on translated catalogs.

## Add a language

1. Copy `catalog-en.ts` to `catalog-<language-code>.ts` and translate its values.
   Rename the exported constant, retain every ID, and keep `satisfies MessageCatalog`.
2. Register the catalog in `src/shared/i18n/locales.ts` with:
   - a specific, stable BCP 47 storage code;
   - a native-language `label`;
   - a locale matcher (receives an `Intl.Locale`);
   - `fontFallback` (empty unless the language needs additional fonts).
3. Add locale-detection cases to `tests/i18n.test.ts`. Include nearby locales that
   must **not** select your language.
4. Run the checks below and switch languages in Settings → Appearance to check
   text wrapping, dialogs, cards, tooltips, and accessible labels.

The picker, supported-language type, catalog validation, and locale detection
all use the registry. Adding a language should not require changes across UI files.

For example, a Japanese entry would match `locale.language === 'ja'`. Script
variants require more care: Simplified Chinese uses the `zh-CN` catalog for Hans
locales, while Traditional Chinese locales currently fall back to English. Do not
reuse `zh-CN` for a future Traditional Chinese translation.

Saved language choices are retained. Fresh desktop installations use the OS locale;
older desktop installations without a language setting remain Korean. A fresh browser
workspace uses the browser locale. Translation lookup has an English fallback for
unexpected missing runtime messages, but incomplete committed catalogs fail checks.

## Add a message in application code

1. Add a readable, semantic ID to `catalog-ko.ts`, and add the same ID to every
   registered translation catalog. Prefer contextual names such as `ui.browserWorkspaceBackup`.
2. Use `useT()` in React components so language changes trigger a render:

   ```tsx
   const t = useT()
   return <Button aria-label={t('ui.settings')}>{t('ui.settings')}</Button>
   ```

3. Use `t` from `src/main/i18n.ts` for Electron messages. Renderer store actions
   may use `t` from `src/renderer/src/lib/i18n.ts`; it resolves the current language
   when called.
4. Pass user-provided names and external messages as data. Do not use them as
   translation IDs, and do not translate prompts, tags, payload fields, database
   keys, or filenames.
5. Keep component keys stable. Do not remount the application on language changes:
   that loses unsaved editor state. Memoized render-callback containers must also
   subscribe to language changes, as `FolderListView` cards do.

## Validation

```sh
pnpm install --frozen-lockfile
pnpm i18n:check
pnpm run typecheck
pnpm test
pnpm run build
```

`i18n:check` checks all registered catalogs for missing/extra IDs, empty values,
and mismatched or malformed placeholders. It also checks literal translation calls
for valid IDs and argument counts, plus live language switching and preservation of
unsaved card inputs. Pull requests run these checks in the i18n workflow.

When submitting a translation, name the language and describe any terminology
choices or screenshots needing review. Credit existing translators when adapting
their work. The Simplified Chinese catalog incorporates the contribution in PR #18;
the stable-ID migration builds on PR #19.
