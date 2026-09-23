# YouTube rail

The YouTube rail is a special-case presentation surface for records created from the transcript displayed on a YouTube video page. To create one, the user opens the transcript, selects it with the normal block picker, and submits that transcript as the analysis source. It only operates on transcript text and timestamps: the extension does not process video frames or audio directly.

When the submitted transcript includes usable timestamps, the rail loads the completed record, turns topic or summary entries into timestamped cards using the transcript sentence timestamps, and keeps the active card aligned with the player’s current time. Without timestamped transcript source data, the timestamp links and playback synchronization are not available.

Selecting a card seeks the video. The rail also supports hierarchy levels and chat events; evidence selected from chat can seek back to the transcript timestamp. Unlike the normal in-page rail, it does not need to rediscover article DOM selectors.

Entrypoint: [`src/content/rails/youtube/controller.jsx`](../src/content/rails/youtube/controller.jsx)
