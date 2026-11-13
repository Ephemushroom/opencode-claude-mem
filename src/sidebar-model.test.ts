import { describe, expect, test } from 'bun:test'
import { describeDetail, formatAge, stripProjectName } from './sidebar-model'

describe('stripProjectName', () => {
  test('drops the project name and the punctuation it leaves behind', () => {
    expect(stripProjectName('发布 opencode-claude-mem 0.7.0 前核查', 'opencode-claude-mem')).toBe(
      '发布 0.7.0 前核查'
    )
    expect(stripProjectName('Opencode-Claude-Mem: fix sidebar', 'opencode-claude-mem')).toBe(
      'fix sidebar'
    )
    expect(stripProjectName('bump @scope/opencode-claude-mem to 0.7', 'opencode-claude-mem')).toBe(
      'bump to 0.7'
    )
  })

  test('keeps names inside longer tokens and titles that are only the name', () => {
    expect(stripProjectName('my-opencode-claude-mem-fork', 'opencode-claude-mem')).toBe(
      'my-opencode-claude-mem-fork'
    )
    expect(stripProjectName('opencode-claude-mem', 'opencode-claude-mem')).toBe(
      'opencode-claude-mem'
    )
  })
})

describe('formatAge', () => {
  const now = Date.UTC(2026, 10, 13, 12, 0)
  test('uses minutes, hours and days, then a calendar date', () => {
    expect(formatAge(now - 20_000, now)).toBe('just now')
    expect(formatAge(now - 12 * 60_000, now)).toBe('12m ago')
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('2d ago')
    expect(formatAge(now - 30 * 86_400_000, now)).toMatch(/^\d{2}-\d{2}$/)
    expect(formatAge(null, now)).toBe('')
  })
})

describe('describeDetail', () => {
  test('renders an observation with its facts and a lookup hint', () => {
    const detail = describeDetail('observation', 7, {
      title: 'Fix &amp; ship',
      subtitle: 'Short',
      type: 'bugfix',
      narrative: 'Long story',
      facts: '["one","two"]',
      files_modified: '[]',
    })
    expect(detail?.title).toBe('#7 Fix & ship')
    expect(detail?.message).toContain('Facts\n• one\n• two')
    expect(detail?.message).not.toContain('Files modified')
    expect(detail?.message).toContain('get_observations([7])')
  })

  test('renders a session summary from its <item> lists', () => {
    const detail = describeDetail('summary', 3, {
      request: 'Ship 0.7.0',
      learned: '<item>a</item>\n<item>b</item>',
    })
    expect(detail?.title).toBe('Ship 0.7.0')
    expect(detail?.message).toContain('Learned\n• a\n• b')
    expect(describeDetail('summary', 3, null)).toBeNull()
  })
})
