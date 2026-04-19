// ============================================================================
// Netease Cloud Music Direct API Client
// POSTs directly to music.163.com/weapi/* — no external server required.
// Cookies are managed automatically by the plugin's Electron session partition.
// ============================================================================

import { buildWEApiBody } from './crypto'

const BASE_URL = 'https://music.163.com'

const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Referer: 'https://music.163.com',
  'Content-Type': 'application/x-www-form-urlencoded',
}

export type FetchFn = (url: string, options?: RequestInit) => Promise<Response>
export type LogFn = (level: 'info' | 'warn' | 'error', message: string, ...args: unknown[]) => void

// --- Response types ---

export interface NeteaseUser {
  userId: number
  nickname: string
  avatarUrl: string
}

export interface NeteasePlaylist {
  id: number
  name: string
  description: string | null
  coverImgUrl: string
  trackCount: number
  playCount: number
  creator: { userId: number; nickname: string }
  trackIds?: Array<{ id: number }>
}

export interface NeteaseTrack {
  id: number
  name: string
  ar: Array<{ id: number; name: string }>
  al: { id: number; name: string; picUrl: string }
  dt: number // duration in ms
  fee: number // 0=free, 1=VIP, 4=paid album, 8=free with ad
  noCopyrightRcmd: unknown // non-null if no copyright
}

export interface NeteaseSongUrl {
  id: number
  url: string | null
  type: string
  size: number
  level: string
  fee: number
  freeTrialInfo: unknown
}

export interface NeteaseLyric {
  lrc?: { lyric: string }
  tlyric?: { lyric: string } // translated lyrics
  romalrc?: { lyric: string } // romanized lyrics
}

// --- Client ---

export class NeteaseApiClient {
  private fetchFn: FetchFn
  private log: LogFn

  constructor(options: { fetch: FetchFn; log: LogFn }) {
    this.fetchFn = options.fetch
    this.log = options.log
  }

  private async post<T>(path: string, params: Record<string, unknown>): Promise<T> {
    const url = `${BASE_URL}/weapi${path}`
    const body = await buildWEApiBody({ ...params, csrf_token: '' })
    const resp = await this.fetchFn(url, {
      method: 'POST',
      headers: REQUEST_HEADERS,
      body,
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '(unreadable)')
      const msg = `Netease API ${resp.status} for ${path} — ${text.slice(0, 200)}`
      this.log('error', msg)
      throw new Error(msg)
    }

    return (await resp.json()) as T
  }

  // --- Auth ---

  async getQrKey(): Promise<string> {
    const resp = await this.post<{ code: number; data?: { unikey?: string } }>(
      '/login/qrcode/uniapp/create',
      { type: 1 },
    )
    const key = resp.data?.unikey
    if (!key) throw new Error('Failed to get QR key')
    return key
  }

  /** Returns status code: 800=expired, 801=waiting, 802=scanned, 803=success */
  async checkQr(key: string): Promise<number> {
    const resp = await this.post<{ code: number }>('/login/qrcode/client/login', {
      key,
      type: 1,
    })
    return resp.code
  }

  async getLoginStatus(): Promise<NeteaseUser | null> {
    try {
      const resp = await this.post<{
        account?: { id: number }
        profile?: { nickname: string; avatarUrl: string }
      }>('/w/nuser/account/get', {})
      if (!resp.account || !resp.profile) return null
      return {
        userId: resp.account.id,
        nickname: resp.profile.nickname,
        avatarUrl: resp.profile.avatarUrl,
      }
    } catch {
      return null
    }
  }

  // --- Search ---

  async search(
    keywords: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ songs: NeteaseTrack[]; songCount: number }> {
    const resp = await this.post<{ result?: { songs?: NeteaseTrack[]; songCount?: number } }>(
      '/cloudsearch/pc',
      { s: keywords, type: 1, limit: options.limit ?? 30, offset: options.offset ?? 0, total: true },
    )
    return {
      songs: resp.result?.songs ?? [],
      songCount: resp.result?.songCount ?? 0,
    }
  }

  // --- Song ---

  async getSongUrl(ids: number[], level = 'exhigh'): Promise<NeteaseSongUrl[]> {
    const resp = await this.post<{ data?: NeteaseSongUrl[] }>('/song/enhance/player/url/v1', {
      ids: JSON.stringify(ids),
      level,
      encodeType: 'flac',
    })
    return resp.data ?? []
  }

  async getSongDetail(ids: number[]): Promise<NeteaseTrack[]> {
    const resp = await this.post<{ songs?: NeteaseTrack[] }>('/v3/song/detail', {
      c: JSON.stringify(ids.map((id) => ({ id: String(id) }))),
      ids: JSON.stringify(ids),
    })
    return resp.songs ?? []
  }

  async getLyric(id: number): Promise<NeteaseLyric> {
    return this.post<NeteaseLyric>('/song/lyric', { id, lv: -1, kv: -1, tv: -1 })
  }

  // --- Playlist ---

  async getUserPlaylists(uid: number, limit = 30, offset = 0): Promise<NeteasePlaylist[]> {
    const resp = await this.post<{ playlist?: NeteasePlaylist[] }>('/user/playlist', {
      uid,
      limit,
      offset,
      includeVideo: true,
    })
    return resp.playlist ?? []
  }

  async getPlaylistDetail(id: number): Promise<{ playlist: NeteasePlaylist; songs: NeteaseTrack[] }> {
    const resp = await this.post<{
      playlist?: NeteasePlaylist & { tracks?: NeteaseTrack[]; trackIds?: Array<{ id: number }> }
    }>('/v6/playlist/detail', { id, n: 100000, s: 8 })

    const playlist = resp.playlist
    if (!playlist) throw new Error(`Playlist ${id} not found`)

    let songs = playlist.tracks ?? []

    // If trackCount > returned tracks, fetch all IDs in batches
    if (playlist.trackIds && playlist.trackIds.length > songs.length) {
      songs = await this.getSongDetailBatched(playlist.trackIds.map((t) => t.id))
    }

    return { playlist, songs }
  }

  async getSongDetailBatched(ids: number[]): Promise<NeteaseTrack[]> {
    const BATCH = 500
    const results: NeteaseTrack[] = []
    for (let i = 0; i < ids.length; i += BATCH) {
      const songs = await this.getSongDetail(ids.slice(i, i + BATCH))
      results.push(...songs)
    }
    return results
  }
}
