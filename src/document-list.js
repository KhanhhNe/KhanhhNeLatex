function updatedAt(document) {
  const numeric = Number(document.updated_at);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(document.updated_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cloudKey(ownerId, cloudId) {
  return `cloud:${ownerId}:${cloudId}`;
}

export function mergeDocuments(localDocuments, cloudDocuments, ownerId) {
  const cloudByKey = new Map((ownerId ? cloudDocuments : []).map(document => [
    cloudKey(ownerId, document.id), document,
  ]));
  const localByKey = new Map();

  for (const document of localDocuments) {
    const key = ownerId && document.owner === ownerId && document.cloudId
      ? cloudKey(ownerId, document.cloudId)
      : `local:${document.id}`;
    const existing = localByKey.get(key);
    if (!existing || (document.dirty && !existing.document.dirty)
      || (Boolean(document.dirty) === Boolean(existing.document.dirty)
        && updatedAt(document) > updatedAt(existing.document))) {
      localByKey.set(key, { key, document });
    }
  }

  const merged = [];
  for (const { key, document } of localByKey.values()) {
    const cloudItem = cloudByKey.get(key) || null;
    const remoteIsNewer = cloudItem && !document.dirty && updatedAt(cloudItem) > updatedAt(document);
    merged.push({
      ...document,
      ...(remoteIsNewer ? { title: cloudItem.title } : {}),
      updated_at: remoteIsNewer ? cloudItem.updated_at : document.updated_at,
      localUpdatedAt: document.updated_at,
      key,
      localAvailable: true,
      cloudAvailable: Boolean(cloudItem),
      cloudItem,
    });
  }

  for (const [key, document] of cloudByKey) {
    if (!localByKey.has(key)) {
      merged.push({
        ...document,
        key,
        localAvailable: false,
        cloudAvailable: true,
        cloudItem: document,
      });
    }
  }

  return merged.sort((first, second) =>
    updatedAt(second) - updatedAt(first) || first.key.localeCompare(second.key));
}
