import { metadata, saveCollection, trashCollection } from "./drive";
import { serverRequest } from "./create-bookmark-server";
import { validateCollection, validateId } from "./library";
import type { Collection, CollectionInput } from "./types";

export async function saveCollectionOnServer(input: CollectionInput, accessToken: string, existing?: Collection): Promise<Collection> {
  const data = validateCollection(input), request = serverRequest(accessToken);
  let createIds: { folder: string; config: string } | undefined;
  if (!existing?.configId) {
    const { ids } = await (await request(`files/generateIds?count=${existing ? 1 : 2}&space=drive&type=files`)).json();
    createIds = { folder: existing?.id ?? validateId(ids?.[0]), config: validateId(ids?.[existing ? 0 : 1]) };
  }
  try { return await saveCollection(data, existing, request, createIds); }
  catch (error) {
    // New folders with failed settings should not be left behind as empty collections.
    if (!existing && createIds) {
      try {
        const folder = await metadata(createIds.folder, request);
        await trashCollection({ ...data, id: folder.id, modifiedTime: folder.modifiedTime }, request);
      } catch { /* The client refreshes from Drive if cleanup also fails. */ }
    }
    throw error;
  }
}
export async function deleteCollectionOnServer(existing: Collection, accessToken: string): Promise<void> {
  const request = serverRequest(accessToken), file = await metadata(validateId(existing.id), request);
  if (file.mimeType !== "application/vnd.google-apps.folder" || file.appProperties?.app !== "rainbow" || file.appProperties?.kind !== "collection") throw new Error("Invalid collection reference.");
  if (file.appProperties.system === "unsorted") throw new Error("Unsorted cannot be deleted.");
  await trashCollection(existing, request);
}
