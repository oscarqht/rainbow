# Rainbow

![Rainbow](./public/poster.png)

A Raindrop-style bookmark manager that stores collections, bookmarks, and files in the user's own Google Drive. Next.js handles the Google OAuth exchange so the client secret stays on the server; access and refresh tokens are kept in the browser's `localStorage`.

Without Google credentials configured, Rainbow runs in demo mode, which keeps changes on the device.

## Setup

Requires Node.js 22.12+.

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev
```

### Google Cloud

1. Create a Google Cloud project and enable the **Google Drive API**.
2. Configure the OAuth consent screen and add the scopes `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/drive.file`.
3. Create an **OAuth client ID** of type *Web application*.
4. Add an authorized redirect URI for each environment, for example:
   - `http://localhost:3000/api/auth/callback`
   - `https://your-domain.example/api/auth/callback`

### Environment variables

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth web client secret (server-only, never prefixed with `NEXT_PUBLIC_`) |
| `GOOGLE_REDIRECT_URI` | Must exactly match a registered redirect URI |

## Drive layout

```text
Rainbow/
├── _assets/            covers and uploaded files referenced by Drive file ID
├── Unsorted/
└── My Collection/
    ├── _collection.json
    ├── Example bookmark.json
    └── Nested Collection/
```

Rainbow uses the `drive.file` scope, so it can see only the files it created or that the user opened with it.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Unit tests (OAuth and Drive) |
| `npm run typecheck` / `npm run lint` | Static checks |

## Security note

A refresh token in `localStorage` can be read by any script running on the origin. The strict Content Security Policy in `next.config.ts` reduces this risk, but a server-held refresh token with an HttpOnly session cookie would be stronger.

Choose **File** when adding a bookmark to upload any nonempty file up to 50 MB. Image files use the uploaded original as their cover; other files can have a separate cover. File bookmarks open privately in Google Drive. In demo mode, files stay in IndexedDB on this device and the open action downloads them.

### Migrate from Raindrop

Connect Google Drive, open account settings, and choose **Migrate from Raindrop**.
Paste a Raindrop API token and start the migration. The dialog shows discovery,
collection/bookmark counts, download/upload bytes, and failures. It copies all
accessible collections (including shared collections and Unsorted), preserving
nesting and sibling order. Trash and permanent webpage archives are excluded.
Existing Rainbow content is retained; imported collections are separate, including
an imported Unsorted collection. Ordinary externally hosted bookmarks remain links.

Uploaded originals, collection icons, and bookmark covers/media are downloaded and
re-uploaded into `_assets`. Extra Raindrop bookmark metadata is retained in the
bookmark JSON's `raindrop` field, including the original URL, timestamps, favorites,
and highlights. Rainbow's displayed field limits still apply; the original values
remain in this metadata. Migration never writes to Raindrop.

Keep the tab open while migrating. Pause finishes the current operation and saves
progress; closing/reloading the tab stops further operations. Reopen the dialog and
enter the token again to resume or retry failed items. Checkpoints and preallocated
Drive IDs prevent retries from creating duplicate content. The token is kept only
in memory, never in Drive checkpoints. A completed migration is retained as a
one-time import, rather than updating previously imported content on later runs.
For a consistent snapshot, avoid reorganizing Raindrop during discovery.

The importer spaces Raindrop requests at least 750 ms apart and honors rate-limit
headers and 429 waits. Other apps using the same Raindrop account can still consume
the account's shared allowance. File transfers use temporary server disk and 8 MiB
Drive resumable upload chunks, verifying byte count and MD5 before success. They
bypass the normal 50 MB attachment limit. Deploy the Node route with sufficient
temporary disk for the largest file and streaming responses enabled; its configured
maximum duration is 300 seconds, compatible with Vercel Hobby with Fluid Compute.
The browser orchestrates separate requests, so the whole import can run longer.
Each asset transfer stops after 280 seconds to allow cleanup and a retryable error
before the host deadline. Large or slow files may still exceed this per-file limit.
Quota, unavailable originals, disk capacity, or host timeouts leave explicit
retryable failures; they are never reported as a completed migration. Missing icons
or covers do not prevent the collection and its links from being copied. Run only one
migration for a given library at a time; browsers with Web Locks also prevent
simultaneous runs in tabs on the same device.
