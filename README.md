# Mediary

A personal media diary (a personal Backloggd) — log games, movies, TV,
anime, books and music with ratings, reviews, cover images and video links.

## Running

```
npm install
npm start
```

## Building a Windows .exe

```
npm install --save-dev electron-builder
npm run dist
```

The portable executable lands in `dist/`.

## Where your data lives

Everything is stored in `%APPDATA%\Mediary\library\` (data from the old
MediaLog name is migrated there automatically on first launch):

- `library.json` — all media items and logs
- `images\` — cover images, copied in when you pick them

The **Data folder** button in the app opens this folder. Back it up by copying
it anywhere; **Export** saves a standalone JSON snapshot.

## Architecture (and why)

```
main.js      — Electron main process. Owns ALL data access (the storage layer).
preload.js   — the bridge: the small, explicit API the UI is allowed to call.
renderer/    — the UI: plain HTML/CSS/JS, no framework.
build/       — icon source (icon.svg) and generated icon.ico.
tools/       — make-icons.js regenerates the icons from the SVG.
```

Design decisions made with the future public version in mind:

- **Media and logs are separate.** A `media` item (the game/movie itself) can
  have many `logs` (each playthrough/rewatch). This is how rewatches work, and
  later it lets media become shared/canonical while logs become per-user.
- **UUIDs everywhere** — entries can be merged into a shared database later
  without ID collisions.
- **Ratings are stored as integers 0–10** (half-stars), displayed as 0–5 stars.
- **All storage goes through `main.js`.** Migrating JSON → SQLite → a server
  database means changing one file; the UI doesn't care.
- **Images are files on disk** (UUID names), never blobs in the database.
  Videos are stored as URLs and embedded, never downloaded.

## Data shape

```json
{
  "version": 1,
  "media": [
    { "id": "uuid", "title": "Outer Wilds", "type": "game",
      "releaseYear": 2019, "coverImage": "uuid.jpg" }
  ],
  "logs": [
    { "id": "uuid", "mediaId": "uuid", "dateConsumed": "2026-06-10",
      "status": "completed", "rating": 9, "review": "…",
      "videoUrl": null, "createdAt": "…", "updatedAt": "…" }
  ]
}
```

`status` is one of: `completed`, `in-progress`, `dropped`, `backlog`, `wishlist`.

## Metadata autofill

Type a title in the Add entry dialog and click **Autofill** (or press Enter):
the app searches the right database for the entry's type and fills in the
title, year and cover art with one click.

| Type | Source | Needs a key? |
| --- | --- | --- |
| Books | Open Library | No |
| Music | iTunes Search | No |
| Movies / TV / Anime | TMDB | Free key: themoviedb.org → account Settings → API |
| Games | IGDB | Free app at dev.twitch.tv/console/apps (Client ID + Secret) |

Keys are entered via the gear icon in the app and stored locally in
`%APPDATA%\Mediary\settings.json`.

## Roadmap

- **V1.x** — tags/genres, import, stats dashboard (entries per month, average
  rating by type), "year in review", glass UI pass
- **V2** — swap JSON for SQLite if the library gets big
- **V3 (public)** — move the storage layer behind a real server (Postgres),
  add accounts; media table becomes shared/canonical, logs get a `userId`
