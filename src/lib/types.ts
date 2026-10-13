export type Tokens = { accessToken: string; refreshToken: string; expiresAt: number; accountId: string; email: string; name: string };
export type RaindropOrigin = { accountId: string; item: Record<string, unknown>; assets: { url: string; id: string }[] };
export type BookmarkData = { schemaVersion: 1; url: string; title: string; description: string; note: string; tags: string[]; coverFileId?: string; file?: { id: string; name: string; mimeType: string }; raindrop?: RaindropOrigin };
export type Bookmark = BookmarkData & { id: string; parentId: string; modifiedTime: string; version: string; etag?: string; demoCover?: string };
export type Collection = { id: string; parentId: string; name: string; iconFileId?: string; color?: string; order: number; view: "grid" | "list"; configId?: string; configVersion?: string; configEtag?: string; configModifiedTime?: string; version?: string; modifiedTime?: string; etag?: string; system?: "unsorted" };
export type Library = { rootId: string; assetsId: string; unsortedId: string; collections: Collection[]; bookmarks: Bookmark[]; changeToken?: string; syncedAt: string };
export type CollectionInput = { name: string; parentId: string; iconFileId?: string; color?: string; order: number; view: "grid" | "list" };
