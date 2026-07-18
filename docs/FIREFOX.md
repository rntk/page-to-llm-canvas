# Firefox

PageToLLMCanvas supports Firefox 121+ on desktop and Android via the same MV3
codebase used for Chrome.

## Build first

```bash
npm ci
npm run build
```

This produces the `dist/` directory used by all the steps below.

## Desktop: temporary install

1. Open `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on" and pick `dist/manifest.json`.

This lasts until Firefox restarts. Alternatively, run:

```bash
npm run start:firefox
```

which launches Firefox with the extension already installed via `web-ext`.

## Desktop: permanent unsigned install

Firefox only allows permanent installs of unsigned extensions on
**Developer Edition**, **Nightly**, or **ESR**, with the
`xpinstall.signatures.required` preference set to `false` in `about:config`.
With that set, install the zip produced by:

```bash
npm run package:firefox
```

## Android

Connect a device over USB with Android USB debugging enabled, `adb`
installed, and Firefox for Android installed on the device, then run:

```bash
npm run start:firefox:android
```

`web-ext` will prompt you to select the target device.

Alternatively, Firefox for Android Nightly has a secret debug menu: in
Settings > About, tap the Firefox logo five times. This enables "Install
extension from file", which accepts the zip produced by
`npm run package:firefox`.

## Host permissions must be granted after install

Firefox MV3 treats `host_permissions` (`<all_urls>`) as **optional and off
by default**, unlike Chrome. After installing the extension, open the
Extensions panel, select this extension, and choose "Always allow on this
site" (or go to Settings/Manage Extension > Permissions) to grant site
access. Without this, the content script will not run and "Pick Blocks"
will do nothing.

## Sentence highlighting on older Firefox versions

Sentence highlighting uses the CSS Custom Highlight API, which Firefox
supports from version 140. On Firefox 121-139 the extension works, but
highlighted-sentence styling is absent (the feature is detected at runtime
and degrades gracefully).

## Distribution without the store

To distribute an installable `.xpi` without listing on addons.mozilla.org,
sign the build via the AMO unlisted channel using your AMO API keys:

```bash
web-ext sign --source-dir dist --channel unlisted
```
