import { afterAll, describe, expect, test } from 'bun:test'
import { cacheDirectory, captureStatusWriter, readCaptureStatus, statusKey } from './capture-status'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'mem-capture-status-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('capture status', () => {
  test('carries the server part report to the sidebar, per checkout', () => {
    // Given a status written for one checkout.
    const status = { state: 'problem', message: 'capture off · Worker did not start' } as const
    captureStatusWriter('/work/alpha', dir).write(status)
    // When the sidebar reads it; then that checkout gets it and another does not.
    expect(readCaptureStatus('/work/alpha', dir)).toEqual(status)
    expect(readCaptureStatus('/work/alpha/', dir)).toEqual(status)
    expect(readCaptureStatus('/work/beta', dir)).toBeNull()
  })

  test('is found through a symlink to the same checkout', () => {
    // Given a checkout the server part and the sidebar name through different paths.
    const real = join(dir, 'real-checkout')
    mkdirSync(real)
    symlinkSync(real, join(dir, 'linked-checkout'))
    captureStatusWriter(real, dir).write({ state: 'ok', message: '' })
    // When it is read through the link; then it is the same status.
    expect(readCaptureStatus(join(dir, 'linked-checkout'), dir)).toEqual({
      state: 'ok',
      message: '',
    })
  })

  test('one instance unloading leaves another instance of the same checkout visible', () => {
    // Given two server instances on one checkout, as during a plugin reload.
    const old = captureStatusWriter('/work/gamma', dir)
    const next = captureStatusWriter('/work/gamma', dir)
    old.write({ state: 'problem', message: 'capture off · old' })
    next.write({ state: 'ok', message: '' })
    // When the old one is disposed; then the new one's status is what the sidebar shows.
    old.clear()
    expect(readCaptureStatus('/work/gamma', dir)).toEqual({ state: 'ok', message: '' })
    next.clear()
    expect(readCaptureStatus('/work/gamma', dir)).toBeNull()
  })

  test('ignores and removes a status whose writer has exited, and unreadable files', () => {
    // Given a status left by a process that no longer exists, and a broken file.
    const child = Bun.spawnSync([
      process.execPath,
      '-e',
      'process.stdout.write(String(process.pid))',
    ])
    const stale = { state: 'problem', message: 'old', pid: Number(child.stdout.toString()) }
    const folder = join(dir, 'status')
    const key = statusKey('/work/delta')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `${key}.1.stale.json`), JSON.stringify(stale))
    writeFileSync(join(folder, `${key}.2.broken.json`), '{not json')
    // When they are read; then neither stays on screen or on disk.
    expect(readCaptureStatus('/work/delta', dir)).toBeNull()
    expect(readdirSync(folder).filter((name) => name.startsWith(key))).toEqual([])
    expect(readCaptureStatus('/work/never-written', dir)).toBeNull()
  })
})

describe('cacheDirectory', () => {
  test('follows XDG_CACHE_HOME, then the home cache', () => {
    expect(cacheDirectory({ XDG_CACHE_HOME: '/xdg' }, '/home/u')).toBe(
      join('/xdg', 'opencode-claude-mem')
    )
    expect(cacheDirectory({}, '/home/u')).toBe(join('/home/u', '.cache', 'opencode-claude-mem'))
  })
})
