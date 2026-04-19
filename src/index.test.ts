import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NeteaseApiClient } from './api-client'
import { randomSecretKey, weapi, buildWEApiBody } from './crypto'
import { NeteaseDataSourcePlugin } from './index'

// ============================================================================
// Crypto Tests
// ============================================================================

describe('crypto', () => {
  describe('randomSecretKey', () => {
    it('should generate 16 bytes from base62 charset', () => {
      const key = randomSecretKey()
      expect(key).toHaveLength(16)
      const base62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
      for (const byte of key) {
        expect(base62.includes(String.fromCharCode(byte))).toBe(true)
      }
    })

    it('should produce different keys on each call', () => {
      const k1 = randomSecretKey()
      const k2 = randomSecretKey()
      // Extremely unlikely to be equal
      expect(k1).not.toEqual(k2)
    })
  })

  describe('weapi', () => {
    it('should return params and encSecKey strings', async () => {
      const result = await weapi({ s: 'test', type: 1 })
      expect(typeof result.params).toBe('string')
      expect(typeof result.encSecKey).toBe('string')
      expect(result.params.length).toBeGreaterThan(0)
      expect(result.encSecKey).toHaveLength(256) // RSA-1024 = 256 hex chars
    })

    it('should produce different output on each call (random key)', async () => {
      const r1 = await weapi({ s: 'hello' })
      const r2 = await weapi({ s: 'hello' })
      // Different random keys → different params (with extremely high probability)
      expect(r1.params).not.toBe(r2.params)
    })
  })

  describe('buildWEApiBody', () => {
    it('should produce URL-encoded params and encSecKey', async () => {
      const body = await buildWEApiBody({ s: 'test' })
      expect(body).toContain('params=')
      expect(body).toContain('encSecKey=')
    })
  })
})

// ============================================================================
// API Client Tests
// ============================================================================

function createMockFetch(responseData: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseData,
    text: async () => JSON.stringify(responseData),
    headers: new Headers(),
    arrayBuffer: async () => new ArrayBuffer(0),
  })) as unknown as typeof fetch
}

describe('NeteaseApiClient', () => {
  let client: NeteaseApiClient
  let mockFetch: ReturnType<typeof createMockFetch>

  beforeEach(() => {
    mockFetch = createMockFetch({})
    client = new NeteaseApiClient({ fetch: mockFetch, log: vi.fn() })
  })

  describe('search', () => {
    it('should POST to /weapi/cloudsearch/pc with encrypted body', async () => {
      mockFetch = createMockFetch({
        result: {
          songs: [
            {
              id: 123,
              name: 'Test Song',
              ar: [{ id: 1, name: 'Artist' }],
              al: { id: 1, name: 'Album', picUrl: 'https://img.com/cover.jpg' },
              dt: 240000,
              fee: 0,
              noCopyrightRcmd: null,
            },
          ],
          songCount: 1,
        },
      })
      client = new NeteaseApiClient({ fetch: mockFetch, log: vi.fn() })

      const result = await client.search('test')
      expect(result.songs).toHaveLength(1)
      expect(result.songs[0]!.name).toBe('Test Song')
      expect(result.songCount).toBe(1)

      const [calledUrl, calledInit] = (mockFetch as any).mock.calls[0]
      expect(calledUrl).toBe('https://music.163.com/weapi/cloudsearch/pc')
      expect(calledInit.method).toBe('POST')
      expect(calledInit.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded')
      expect(calledInit.body).toContain('params=')
      expect(calledInit.body).toContain('encSecKey=')
    })

    it('should handle empty results', async () => {
      mockFetch = createMockFetch({ result: {} })
      client = new NeteaseApiClient({ fetch: mockFetch, log: vi.fn() })

      const result = await client.search('nonexistent')
      expect(result.songs).toEqual([])
      expect(result.songCount).toBe(0)
    })
  })

  describe('getSongUrl', () => {
    it('should POST to /weapi/song/enhance/player/url/v1', async () => {
      mockFetch = createMockFetch({
        data: [
          {
            id: 123,
            url: 'https://m701.music.126.net/song.mp3',
            type: 'mp3',
            size: 5000000,
            level: 'exhigh',
            fee: 0,
            freeTrialInfo: null,
          },
        ],
      })
      client = new NeteaseApiClient({ fetch: mockFetch, log: vi.fn() })

      const result = await client.getSongUrl([123], 'lossless')
      expect(result).toHaveLength(1)
      expect(result[0]!.url).toBe('https://m701.music.126.net/song.mp3')

      const [calledUrl] = (mockFetch as any).mock.calls[0]
      expect(calledUrl).toBe('https://music.163.com/weapi/song/enhance/player/url/v1')
    })
  })

  describe('getSongDetail', () => {
    it('should POST to /weapi/v3/song/detail', async () => {
      mockFetch = createMockFetch({
        songs: [
          {
            id: 1,
            name: 'Song A',
            ar: [{ id: 1, name: 'A' }],
            al: { id: 1, name: 'Album A', picUrl: '' },
            dt: 180000,
            fee: 0,
            noCopyrightRcmd: null,
          },
        ],
      })
      client = new NeteaseApiClient({ fetch: mockFetch, log: vi.fn() })

      const result = await client.getSongDetail([1])
      expect(result).toHaveLength(1)

      const [calledUrl] = (mockFetch as any).mock.calls[0]
      expect(calledUrl).toBe('https://music.163.com/weapi/v3/song/detail')
    })
  })

  describe('getLyric', () => {
    it('should POST to /weapi/song/lyric', async () => {
      mockFetch = createMockFetch({
        lrc: { lyric: '[00:01.00]Hello world' },
        tlyric: { lyric: '[00:01.00]你好世界' },
      })
      client = new NeteaseApiClient({ fetch: mockFetch, log: vi.fn() })

      const result = await client.getLyric(123)
      expect(result.lrc?.lyric).toContain('Hello world')
      expect(result.tlyric?.lyric).toContain('你好世界')

      const [calledUrl] = (mockFetch as any).mock.calls[0]
      expect(calledUrl).toBe('https://music.163.com/weapi/song/lyric')
    })
  })

  describe('getQrKey', () => {
    it('should POST to /weapi/login/qrcode/uniapp/create and return unikey', async () => {
      mockFetch = createMockFetch({ code: 200, data: { unikey: 'test-unikey-xyz' } })
      client = new NeteaseApiClient({ fetch: mockFetch, log: vi.fn() })

      const key = await client.getQrKey()
      expect(key).toBe('test-unikey-xyz')

      const [calledUrl] = (mockFetch as any).mock.calls[0]
      expect(calledUrl).toBe('https://music.163.com/weapi/login/qrcode/uniapp/create')
    })

    it('should throw if unikey is missing', async () => {
      mockFetch = createMockFetch({ code: 200, data: {} })
      client = new NeteaseApiClient({ fetch: mockFetch, log: vi.fn() })
      await expect(client.getQrKey()).rejects.toThrow('Failed to get QR key')
    })
  })

  describe('checkQr', () => {
    it('should return the status code', async () => {
      mockFetch = createMockFetch({ code: 803 })
      client = new NeteaseApiClient({ fetch: mockFetch, log: vi.fn() })

      const code = await client.checkQr('some-key')
      expect(code).toBe(803)

      const [calledUrl] = (mockFetch as any).mock.calls[0]
      expect(calledUrl).toBe('https://music.163.com/weapi/login/qrcode/client/login')
    })
  })

  describe('getUserPlaylists', () => {
    it('should POST to /weapi/user/playlist', async () => {
      mockFetch = createMockFetch({
        playlist: [
          {
            id: 1,
            name: 'My Favorites',
            description: null,
            coverImgUrl: '',
            trackCount: 10,
            playCount: 100,
            creator: { userId: 42, nickname: 'User' },
          },
        ],
      })
      client = new NeteaseApiClient({ fetch: mockFetch, log: vi.fn() })

      const result = await client.getUserPlaylists(42)
      expect(result).toHaveLength(1)
      expect(result[0]!.name).toBe('My Favorites')

      const [calledUrl] = (mockFetch as any).mock.calls[0]
      expect(calledUrl).toBe('https://music.163.com/weapi/user/playlist')
    })
  })

  describe('error handling', () => {
    it('should throw on non-OK response', async () => {
      mockFetch = createMockFetch({ message: 'Rate limited' }, 429)
      client = new NeteaseApiClient({ fetch: mockFetch, log: vi.fn() })
      await expect(client.search('test')).rejects.toThrow(/429/)
    })
  })
})

// ============================================================================
// LRC Parser Tests
// ============================================================================

describe('LRC Parsing', () => {
  it('should parse timed lyrics from plugin getLyrics', async () => {
    const plugin = new NeteaseDataSourcePlugin()

    const mockContext: any = {
      credentials: { get: vi.fn(async () => null), set: vi.fn() },
      config: {
        get: vi.fn(() => null),
        observe: vi.fn(),
      },
      fetch: createMockFetch({}),
      log: vi.fn(),
      commands: { add: vi.fn() },
      notifications: {},
    }

    await plugin.activate(mockContext)

    ;(plugin as any).client.getLyric = vi.fn(async () => ({
      lrc: {
        lyric: `[00:00.00]Song Title
[00:05.50]First line
[00:10.20]Second line
[00:15.00]Third line`,
      },
      tlyric: {
        lyric: `[00:05.50]第一行
[00:10.20]第二行`,
      },
    }))

    const result = await plugin.getLyrics({
      source: { plugin: 'compass-plugin-netease', externalId: '123' },
    })
    expect(result).not.toBeNull()
    expect(result.lines).toHaveLength(4)

    expect(result.lines[0].time).toBe(0)
    expect(result.lines[0].text).toBe('Song Title')

    expect(result.lines[1].time).toBe(5500)
    expect(result.lines[1].text).toBe('First line')
    expect(result.lines[1].translation).toBe('第一行')

    expect(result.lines[2].time).toBe(10200)
    expect(result.lines[2].text).toBe('Second line')
    expect(result.lines[2].translation).toBe('第二行')

    expect(result.lines[3].time).toBe(15000)
    expect(result.lines[3].text).toBe('Third line')
    expect(result.lines[3].translation).toBeUndefined()
  })
})

