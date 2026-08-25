# WFL Codex Android Sync

This Android client is based on the open-source [SyncVault](https://github.com/dhzdhd/SyncVault) project, pinned in this repository at commit `142eda9b7e822bb394da8f39d7faa72a2bb10db3`.
SyncVault supplies the Android UI, local-folder selection, background scheduling, and the RClone sync engine. This fork adds the WFL Codex WebDAV connection profile; it does not replace the upstream sync implementation with a new client.

## Connect to a WFL Codex server

1. Open **Accounts** and create a new remote.
2. Select **WFL Codex** (the upstream model is retained internally as `NextCloud` for saved-data compatibility).
3. Enter the server WebDAV URL:

   ```text
   https://YOUR-DOMAIN/dav
   ```

4. Enter the WFL Codex username and the same password used for the web sign-in.
5. Choose a local Android folder, then create a connection between the local folder and the WFL Codex remote folder.

Each WFL Codex project appears as a folder below the WebDAV root. Files inside a project can be uploaded, downloaded, and synchronized by RClone. If two projects have the same display name, the server adds a short project ID to one of the folder names so the client cannot select the wrong project.

The server must be reached over HTTPS on an ordinary deployment. The rescue window intentionally does not expose `/dav`. In multi-user mode, only the authenticated user's projects and explicitly shared projects are visible; read-only shares cannot be changed from the phone.

## Sync behavior and limits

- Android background work uses WorkManager. Android enforces a minimum periodic interval of about 15 minutes; an immediate manual sync can still be started from the app.
- The server accepts WebDAV `PROPFIND`, `GET`, `HEAD`, `PUT`, `MKCOL`, `DELETE`, `MOVE`, and `COPY` operations.
- A WebDAV delete is moved to the server's recoverable `.codex-trash` area and is hidden from the remote listing.
- Individual WebDAV uploads are limited to 2 GiB by the server, and normal user quota and project permissions still apply.
- Use the server's web UI to recover a deleted item or to permanently manage trash; the mobile client only sees the synchronized project contents.

## Upstream features

The upstream SyncVault project also supports other RClone providers and desktop platforms. Those providers remain in the source tree, but the WFL Codex integration is the **WFL Codex** WebDAV entry described above.

## Build

This directory is a Flutter project. Install Flutter 3.44 or newer and the Android SDK, then run:

```bash
flutter pub get
flutter build apk --release
```

The current development environment may not contain Flutter or an Android SDK, so an APK is only claimed after the build command succeeds.

## License and attribution

The client code is derived from SyncVault and retains its BSD 3-Clause license in [LICENSE.md](LICENSE.md). The WFL Codex server is part of the repository's MIT-licensed application; the client remains separately licensed under BSD 3-Clause.
