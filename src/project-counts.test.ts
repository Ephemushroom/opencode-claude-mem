import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { readProjectCounts, resolveDatabasePath } from './worker-client'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'mem-project-counts-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fixtureDatabase(): string {
  const path = join(dir, 'claude-mem.db')
  const db = new Database(path)
  db.run('CREATE TABLE observations (project TEXT, merged_into_project TEXT)')
  db.run('CREATE TABLE session_summaries (project TEXT, merged_into_project TEXT)')
  db.run('CREATE TABLE sdk_sessions (project TEXT)')
  db.run(`INSERT INTO observations VALUES
    ('Alpha', NULL), ('alpha', NULL), ('old-alpha', 'alpha'), ('beta', NULL)`)
  db.run(`INSERT INTO session_summaries VALUES ('alpha', NULL), ('beta', NULL)`)
  db.run(`INSERT INTO sdk_sessions VALUES ('ALPHA'), ('alpha'), ('beta')`)
  db.close()
  return path
}

describe('readProjectCounts', () => {
  test('counts the project case-insensitively, including merged rows', async () => {
    // Given a Worker database with rows for two projects and one merged project.
    const path = fixtureDatabase()
    // When the sidebar asks for one project's counts.
    const counts = await readProjectCounts(path, 'alpha')
    // Then they match the Worker's own project filter.
    expect(counts).toEqual({ observations: 3, summaries: 1, sessions: 2 })
  })

  test('returns null when the database is missing or has another schema', async () => {
    // Given no database, and a database without the expected tables.
    const other = join(dir, 'other.db')
    new Database(other).close()
    // When counts are read; then the sidebar falls back to global totals.
    expect(await readProjectCounts(join(dir, 'missing.db'), 'alpha')).toBeNull()
    expect(await readProjectCounts(other, 'alpha')).toBeNull()
  })
})

describe('resolveDatabasePath', () => {
  test('uses CLAUDE_MEM_DATA_DIR from env, then settings, then the home default', () => {
    const settings = JSON.stringify({ CLAUDE_MEM_DATA_DIR: '~/mem-data' })
    expect(resolveDatabasePath({ CLAUDE_MEM_DATA_DIR: '/env' }, settings, '/home/me')).toBe(
      '/env/claude-mem.db'
    )
    expect(resolveDatabasePath({}, settings, '/home/me')).toBe('/home/me/mem-data/claude-mem.db')
    expect(resolveDatabasePath({}, null, '/home/me')).toBe('/home/me/.claude-mem/claude-mem.db')
  })

  test('skips the local file when the Worker runs on another host', () => {
    expect(resolveDatabasePath({ CLAUDE_MEM_WORKER_HOST: '10.0.0.5' }, null, '/home/me')).toBeNull()
  })
})
