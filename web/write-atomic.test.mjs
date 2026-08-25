import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { diskError, preflightDest, writeFileAtomic } from './write-atomic.mjs'

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
    const r = await writeFileAtomic(dest, Buffer.from('new'), null)
    assert.equal(r.ok, false)
    assert.equal(r.error, 'EACCES')
    await chmod(dir, 0o755)
    assert.equal(await readFile(dest, 'utf8'), 'old')
  } finally {
    try { await chmod(dir, 0o755) } catch { /* already restored */ }
    await rm(dir, { recursive: true, force: true })
  }
})
