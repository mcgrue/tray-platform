# Codex message attachments

Status: implemented and automated checks passed, 2026-10-25. Physical phone
file-picker/clipboard acceptance remains pending.

## Scope

- Attach files and images to the inbox and Codex Instances message composers on
  desktop and PWA, including new conversations and follow-ups to active/idle turns.
- Choose multiple files, drag/drop files, or paste clipboard images. Show compact
  image thumbnails and file icons, opening a large preview on click with filename/size
  overlays, a trash button to remove the attachment, and a red X to close the preview. Text/source previews are inert and
  bounded; unsupported formats show a file icon. Allow attachment-only messages.
  Preserve drafts across snapshots, tab changes, and failed sends.
- Keep paperclip/send controls together on the right. Show file-count and size
  limits in dismissible toasts when exceeded, without changing the draft.
- PWA message editors use `contenteditable=true` so supporting mobile browsers
  advertise image insertion to the keyboard. Serialize plain text and route
  images into attachments; preserve native undo, composition, and offline locks.
  Smartbar suggestions remain controlled by the browser and keyboard.
- Store bounded uploads as private local copies under Tray user data. Phone
  uploads require existing Tailscale identity, origin, and CSRF protections.
  Bind opaque attachment IDs to the uploader; never accept arbitrary local paths.
- Deliver images as Codex image input and files as exact local file references.
  Preserve the runtime's normal configuration and existing no-replay behavior.
- Keep uploads out of web caches and notification payloads. Do not delete uploaded
  files automatically; retained copies keep conversation references usable.

## Validation

- All 513 Jest tests in 62 suites passed. Build and focused strict TypeScript
  checks passed; `git diff --check` is clean.
- Desktop/PWA attachment smoke passed with installed Codex 26.1021.22027 and a
  deterministic localhost provider. Both composers delivered source files and
  images, including attachment-only new conversations, idle follow-ups, and an
  image steering an active turn. Provider requests contained image input; stored
  files matched the original bytes.
- Picker, drop, paste, previews, narrow layout, per-instance drafts, snapshot/tab
  retention, removal, invalid-image feedback, limits, offline keyboard guards,
  and lost-response recovery without replay passed. Desktop/phone screenshots
  were reviewed.
- Evidence: `%TEMP%/tray-attachments-smoke-i7xaWD/result.json` and screenshots;
  runtime protocol is retained alongside it. No live conversations or external
  inference were used.
- Updated controls/toasts: `%TEMP%/tray-attachments-smoke-RUujUG/result.json`.
  Both composers on desktop/phone passed alignment and picker-click checks;
  oversized files, a sixth file, and excessive combined size preserve the draft.
  Toast replacement, manual/automatic dismissal, and narrow-screen margins passed.
  Build and focused strict TypeScript checks passed; screenshots were reviewed.
- Icon/preview UI: `%TEMP%/tray-attachments-smoke-JqVJBF/result.json` verifies
  both composers on desktop/phone with the installed Codex runtime. Separate UI
  coverage in `%TEMP%/tray-attachment-preview-4mXcI4/result.json` checks overlay
  placement, selected removal, Escape/backdrop dismissal, focus after refresh,
  draft isolation, reconnect state, upload errors, inert/bounded text, long
  filenames, binary fallback, and modal disposal. Screenshots were reviewed.
- Thumbnail and modal-action checks: `%TEMP%/tray-attachment-preview-mBHnVU/result.json`
  verifies the selected image renders in the strip on desktop/phone, retains a
  44-pixel click target, and opens the larger preview. Trash removes the selected
  attachment; the red X closes without removing it. Screenshots were reviewed.
- Existing message, PWA, and instance-message smokes passed. Question smoke passed
  against its supported installed extension 26.1007.21434. With 26.1021.22027,
  that existing question fixture stops before UI testing because its extractor
  depends on old minified function names (`n8t`, `Axn`); it was not expanded here.
- Mobile editing-host update: all 513 Jest tests, build, and focused strict
  TypeScript passed. Editor smoke: `%TEMP%/tray-message-input-DrwKH8/result.json`;
  runtime attachments: `%TEMP%/tray-attachments-smoke-74ExCQ/result.json`;
  PWA inbox and instance checks: `%TEMP%/tray-web-smoke-BfVSZk` and
  `%TEMP%/tray-web-instances-sjDPuW`. Phone layouts were visually reviewed.
  Actual Android keyboard suggestions require physical-device acceptance.
  Firefox's capability mapping is in
  [GeckoEditable.java](https://github.com/mozilla-firefox/firefox/blob/main/mobile/android/geckoview/src/main/java/org/mozilla/geckoview/GeckoEditable.java),
  where contenteditable fields advertise image MIME types to the IME.
- Restart Tray Platform and reload the phone page to load this build. The running
  Tray process was left alone because quitting stops its owned Codex sessions.

# HUMAN QUESTIONS

- Existing affected tests and smoke changes approved by the user.
- Initial limits: 5 attachments, 10 MiB per file, 20 MiB per message. Image previews
  support PNG, JPEG, WebP and GIF; other formats remain ordinary file attachments.
- Structured question-answer controls keep their existing answer contract;
  attachments are available through the conversation's message composer.
