# vite-plugin-static-twig

A Vite plugin that compiles [Twig](https://github.com/twigjs/twig.js) templates into static HTML pages, with full dev-server HMR and multi-locale support.

- Renders all `.twig` files under a configurable pages directory to HTML at build time
- Watches templates and translation JSON files in dev mode and triggers a full browser reload on change
- Injects hashed Vite asset paths (JS / CSS) from the manifest into every rendered page
- Resolves bare Twig template references (`extends`, `include`, `embed`, `import`, `from`) relative to a shared templates root
- Serves pre-rendered HTML from the output directory via a Connect middleware during `vite dev`
- Computes relative `path` prefixes so pages at any nesting depth can reference root-level assets

---

## Requirements

- **Node.js** >= 18
- **Vite** >= 4 (peer dependency)

---

## Installation

```shell
npm install vite-plugin-static-twig
```

---

## Usage

```js
// vite.config.js
import { defineConfig } from 'vite';
import staticPagesPlugin from 'vite-plugin-static-twig';

export default defineConfig({
    plugins: [
        staticPagesPlugin({
            srcDir: 'src',
            staticDir: 'src/templates/pages',
            templatesDir: 'src/templates',
            translationsDir: 'src/translations',
            slugMapPath: 'src/js/json/translations.json',
            locales: ['en', 'fr', 'nl', 'de'],
            defaultLocale: 'en',
            scriptsEntryKey: 'src/js/scripts.js',
        })
    ]
});
```

---

## Options

All options are optional and fall back to sensible defaults.

| Option | Type | Default | Description |
|---|---|---|---|
| `srcDir` | `string` | `'src'` | Root source directory. |
| `staticDir` | `string` | `'src/templates/pages'` | Directory containing Twig page entry files. Files prefixed with `_` are skipped. |
| `templatesDir` | `string` | `'src/templates'` | Shared Twig templates directory (layouts, partials, macros). |
| `translationsDir` | `string` | `'src/translations'` | Directory containing JSON translation files. Must include `global.json` plus one file per locale (e.g. `en.json`). |
| `slugMapPath` | `string` | `'src/js/json/translations.json'` | Project-relative path to a JSON slug translation map used to build language-switcher `href` values at build time. Set to `null` to disable. |
| `useViteAssetsInBuild` | `boolean` | `true` | When `true`, reads the Vite manifest and injects hashed JS/CSS paths into every rendered page. |
| `locales` | `string[]` | `['fr','en','nl','de']` | Locale codes recognised in directory names. The locale is inferred by finding one of these as a path segment. Pass `[]` for non-localised sites. |
| `defaultLocale` | `string` | `'fr'` | Fallback locale used when none of the `locales` are found in the file path. Also used for pages placed at the root of `staticDir`. |
| `scriptsEntryKey` | `string` | `'src/js/scripts.js'` | The Vite manifest key for the JS entry point. Used to look up the hashed JS and CSS filenames. |
| `filters` | `Array<{ name: string, fn: Function }>` | `[]` | Additional Twig filters to register alongside the built-ins. Each entry is passed directly to `Twig.extendFilter(name, fn)`. |

---

## Template variables

The following variables are available in every rendered Twig page.

| Variable | Description |
|---|---|
| `{{ locale }}` | Current language code (e.g. `en`). |
| `{{ path }}` | Relative prefix back to the `dist/` root (e.g. `../` for pages one level deep). Use this to prefix all asset URLs. |
| `{{ isProduction }}` | `true` during `vite build`. |
| `{{ useViteDevServer }}` | `true` during `vite dev`. |
| `{{ useViteAssets }}` | `true` in production when `useViteAssetsInBuild` is enabled. |
| `{{ viteAssets.js }}` | Hashed JS filename from the Vite manifest (production only). |
| `{{ viteAssets.css }}` | Hashed CSS filename from the Vite manifest (production only). |
| `{{ langSwitcherUrls }}` | Map of `{ targetLocale: relativeUrl }` for language-switcher links (requires `slugMapPath`). |

All top-level keys from `global.json` and the current locale JSON file are also injected as Twig variables.

---

## Translation files

Place one JSON file per locale and a `global.json` for shared keys inside `translationsDir`:

```
src/translations/
├── global.json   ← merged into every page regardless of locale
├── en.json
├── fr.json
├── nl.json
└── de.json
```

---

## Page conventions

- Every `.twig` file under `staticDir` that does **not** start with `_` is compiled to HTML.
- The locale is detected from the containing directory name (e.g. `pages/en/my-page.twig` → locale `en`).
- Pages at the root of `staticDir` use `defaultLocale`.
- Bare template references in `extends`, `include`, `embed`, `import`, and `from` tags are automatically resolved relative to `templatesDir`. Paths starting with `.` or `/` are used as-is.

---

## Custom Twig filters

Two filters are registered automatically.

### `external_links`

Adds `target="_blank"`, `rel="noopener noreferrer"`, and a visually hidden screen-reader label to external links and file download links inside an HTML string.

```twig
{{ content|external_links(locale) }}
```

Recognised download extensions: `pdf`, `doc`, `docx`, `xls`, `xlsx`, `pptx`, `zip`.

Screen-reader labels are resolved from a built-in map for `fr`, `nl`, `de`, and `en`. Unknown locales fall back to the French label.

### `entity_encode`

Encodes `mailto:` and `tel:` link `href` values and their visible text as HTML character entities to deter scraper harvesting.

```twig
{{ content|entity_encode }}
```

### Registering additional filters

Pass a `filters` array to the plugin to register your own filters alongside the built-ins.

```js
// vite.config.js
import staticPagesPlugin from 'vite-plugin-static-twig';

export default {
    plugins: [
        staticPagesPlugin({
            filters: [
                { name: 'uppercase', fn: (value) => value?.toUpperCase() ?? value },
                { name: 'prefix',    fn: (value, [pfx = '']) => `${pfx}${value}` }
            ]
        })
    ]
};
```

Filter functions can also be imported from a separate file to keep `vite.config.js` tidy:

```js
// src/twig-filters.js
export const filters = [
    { name: 'uppercase', fn: (value) => value?.toUpperCase() ?? value },
    { name: 'prefix',    fn: (value, [pfx = '']) => `${pfx}${value}` }
];
```

```js
// vite.config.js
import { filters } from './src/twig-filters.js';
import staticPagesPlugin from 'vite-plugin-static-twig';

export default {
    plugins: [staticPagesPlugin({ filters })]
};
```

Each `fn` receives the filtered value as its first argument and an array of filter arguments as its second, matching the signature expected by `Twig.extendFilter`.

---

## Publishing a new version

Pushing a tag that matches `v*` triggers the GitHub Actions workflow which runs `npm publish` automatically.

```shell
git tag v1.2.0
git push origin v1.2.0
```

The workflow requires an `NPM_TOKEN` secret to be set in the GitHub repository settings (Settings → Secrets → Actions).

---

## License

MIT
