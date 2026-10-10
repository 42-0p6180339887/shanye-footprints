// Hosting-specific builds replace this dictionary; the shared site uses local assets.
const ASSET_URLS = {};

export function assetUrl(path) {
  return Object.hasOwn(ASSET_URLS, path) ? ASSET_URLS[path] : new URL(path, import.meta.url).href;
}
