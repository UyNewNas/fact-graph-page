export const normalizeModuleQuery = value => value.trim().replace(/^(?:\.\/|\.\\)?src[/\\]/i, '').replace(/\.lean$/i, '').replace(/[/\\]/g, '.').toLowerCase()

export function sourceModulePath(manifest, name) {
  return manifest.sourceDirectory + '/' + name.replace(/\./g, '/') + '.lean'
}

export function sourceModuleUrl(manifest, name) {
  const path = sourceModulePath(manifest, name).split('/').map(encodeURIComponent).join('/')
  return `https://github.com/${manifest.sourceRepository}/blob/${manifest.sourceCommit}/${path}`
}
