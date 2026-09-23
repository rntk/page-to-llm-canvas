# In-page rails

The in-page rail presents topic or summary cards next to the original selected blocks, with an optional article-chat mode. It fetches the latest saved record, locates the originally selected elements using their stored selectors, maps source sentence numbers to live DOM geometry, and positions cards beside the relevant text.

Card selection highlights or scrolls to the corresponding source sentences. The rail can change topic level and switch to the full canvas or hierarchy view. If the page structure no longer matches the saved selectors, the rail offers the full record view as a recovery path.

Entrypoint: [`src/content/rails/in-page/controller.jsx`](../src/content/rails/in-page/controller.jsx)
