import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { diskError, fileRevision, preflightDest, writeFileAtomic } from './write-atomic.mjs'

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

test('diskError prefers EACCES/EPERM/EROFS over the long message', () => {
  assert.equal(diskError(Object.assign(new Error('EACCES: permission denied, open x'), { code: 'EACCES' })), 'EACCES')
  assert.equal(diskError(Object.assign(new Error('boom'), { code: 'ENOENT' })), 'boom')
})

test('preflightDest reports EACCES on an unwritable parent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'go-ro-'))
  const dest = join(dir, 'f.md')
  await writeFile(dest, '# ro\n')
  await chmod(dir, 0o555)
  try {
    const r = await preflightDest(dest)
    assert.equal(r.ok, false)
    assert.equal(r.error, 'EACCES')
  } finally {
    await chmod(dir, 0o755)
    await rm(dir, { recursive: true, force: true })
  }
})

test('preflightDest exclusive reports exists without overwriting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'go-ex-'))
  const dest = join(dir, 'copy.md')
  await writeFile(dest, 'keep')
  try {
    const r = await preflightDest(dest, true)
    assert.equal(r.ok, false)
    assert.equal(r.error, 'exists')
    assert.equal(await readFile(dest, 'utf8'), 'keep')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeFileAtomic maps a permission error to EACCES', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'go-wa-'))
  const dest = join(dir, 'f.md')
  await writeFile(dest, 'old')
  await chmod(dir, 0o555)
  try {
    const expectedMtimeMs = (await stat(dest)).mtimeMs
    const r = await writeFileAtomic(dest, Buffer.from('new'), expectedMtimeMs)
    assert.equal(r.ok, false)
    assert.equal(r.error, 'EACCES')
    await chmod(dir, 0o755)
    assert.equal(await readFile(dest, 'utf8'), 'old')
  } finally {
    try { await chmod(dir, 0o755) } catch { /* already restored */ }
    await rm(dir, { recursive: true, force: true })
  }
})

test('existing dest without a file version is conflict', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'go-ver-'))
  const dest = join(dir, 'f.md')
  await writeFile(dest, 'old')
  try {
    const r = await writeFileAtomic(dest, Buffer.from('new'), null)
    assert.equal(r.ok, false)
    assert.equal(r.error, 'conflict')
    assert.equal(await readFile(dest, 'utf8'), 'old')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('50ms external edit conflicts on content revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'go-ext-'))
  const dest = join(dir, 'f.md')
  await writeFile(dest, 'baseline')
  const initial = (await stat(dest)).mtimeMs
  await writeFile(dest, 'external edit')
  await utimes(dest, new Date(), new Date(initial + 50))
  try {
    const r = await writeFileAtomic(dest, Buffer.from('agent stale overwrite'), initial, {
      expectedRevision: sha256('baseline'),
    })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'conflict')
    assert.equal(await readFile(dest, 'utf8'), 'external edit')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent same baseline allows at most one success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'go-cc-'))
  const dest = join(dir, 'f.md')
  await writeFile(dest, 'baseline')
  const baselineMtime = (await stat(dest)).mtimeMs
  try {
    const concurrent = await Promise.all([
      writeFileAtomic(dest, Buffer.from('agent A'), baselineMtime),
      writeFileAtomic(dest, Buffer.from('agent B'), baselineMtime),
    ])
    const okCount = concurrent.filter((item) => item.ok).length
    assert.ok(okCount <= 1, `okCount=${okCount}`)
    const body = await readFile(dest, 'utf8')
    assert.ok(body === 'agent A' || body === 'agent B' || body === 'baseline')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('failed write cleans tmp and leaves dest bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'go-cl-'))
  const dest = join(dir, 'f.md')
  await writeFile(dest, 'keep')
  const expectedMtimeMs = (await stat(dest)).mtimeMs
  await chmod(dir, 0o555)
  try {
    const r = await writeFileAtomic(dest, Buffer.from('new'), expectedMtimeMs)
    assert.equal(r.ok, false)
    await chmod(dir, 0o755)
    assert.equal(await readFile(dest, 'utf8'), 'keep')
    const leftovers = (await readdir(dir)).filter((name) => name.includes('.genoffice-write-') && name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    try { await chmod(dir, 0o755) } catch { /* restored */ }
    await rm(dir, { recursive: true, force: true })
  }
})

test('fileRevision hashes bytes', () => {
  assert.equal(fileRevision(Buffer.from('baseline')), sha256('baseline'))
})
