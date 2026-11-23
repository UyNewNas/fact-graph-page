// Transfer optimization only: every decompressed byte is the extractor's JSON.
import assert from 'node:assert/strict'
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { resolve, join } from 'node:path'

const directory = resolve(process.argv[2] || new URL('../public/riemann-modules/', import.meta.url).pathname)
const manifestPath = join(directory, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
if (manifest.compression?.format === 'gzip') {
  for (const [path, expected] of Object.entries(manifest.files)) {
    assert.match(path, /^(?:names\.json|chunks\/\d+\.json)\.gz$/)
    const compressed = await readFile(join(directory, path))
    assert.equal(sha256(compressed), expected.sha256)
    assert.equal(sha256(gunzipSync(compressed)), expected.uncompressedSha256)
  }
  console.log('Compressed index already present; every compressed and decompressed hash verified.')
} else {
  assert.equal(manifest.namesFile, 'names.json')
  assert.equal(manifest.chunkPattern, 'chunks/{chunk}.json')
  const outputFiles = {}
  const originals = []
  for (const [path, expected] of Object.entries(manifest.files)) {
    assert.match(path, /^(?:names\.json|chunks\/\d+\.json)$/)
    const original = await readFile(join(directory, path))
    assert.equal(original.length, expected.bytes)
    assert.equal(sha256(original), expected.sha256)
    const compressed = gzipSync(original, { level: 9, mtime: 0 })
    assert.deepEqual(gunzipSync(compressed), original)
    const filename = path + '.gz'
    await writeFile(join(directory, filename), compressed)
    outputFiles[filename] = {
      bytes: compressed.length, sha256: sha256(compressed),
      uncompressedBytes: original.length, uncompressedSha256: expected.sha256,
    }
    originals.push(path)
  }
  manifest.namesFile += '.gz'
  manifest.chunkPattern += '.gz'
  manifest.compression = { format: 'gzip', contentTypeAfterDecompression: 'application/json', lossless: true }
  manifest.uncompressedDataFileBytes = manifest.dataFileBytes
  manifest.dataFileBytes = Object.values(outputFiles).reduce((sum, file) => sum + file.bytes, 0)
  manifest.files = outputFiles
  manifest.extraction.moduleIdMeaning = 'Index in the lexicographically sorted module-name array (decompress namesFile first)'
  await writeFile(manifestPath + '.tmp', JSON.stringify(manifest, null, 2) + '\n')
  await rename(manifestPath + '.tmp', manifestPath)
  for (const path of originals) await unlink(join(directory, path))
  console.log(`Compressed ${originals.length} JSON files losslessly: ${manifest.uncompressedDataFileBytes} → ${manifest.dataFileBytes} bytes.`)
}
