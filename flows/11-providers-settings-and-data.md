# Providers, settings, and data management

The Options page is the management surface for the active LLM provider, processing preferences, saved records, import/export, diagnostics, and destructive cleanup. Provider settings are validated and stored locally; the pipeline snapshots the active provider at run start so one run uses consistent model and context-window settings.

Preferences such as content-language mode, summary generation, concurrency, theme, highlight color, and verbose logging affect subsequent runs or surfaces according to their scope. Records can be exported/imported, reprocessed, or deleted. Related chats can be revisited or deleted, but are not included in record exports; the data-management controls can remove page data or reset all extension storage.

Entrypoint: [`src/options/OptionsApp.jsx`](../src/options/OptionsApp.jsx)
