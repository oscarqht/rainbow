# Rainbow

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
