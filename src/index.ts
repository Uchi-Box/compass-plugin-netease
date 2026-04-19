// ============================================================================
// Compass Plugin — Netease Cloud Music
// DataSource plugin: search, stream, lyrics, QR login, playlist sync
// Self-contained: calls music.163.com directly via weapi encryption.
// Cookies are managed automatically by the plugin's Electron session partition.
// ============================================================================

import QRCode from 'qrcode'
import { NeteaseApiClient, type NeteaseTrack } from './api-client'

const PLUGIN_ID = 'compass-plugin-netease'

// ============================================================================
// Types (mirroring Compass plugin API without importing from @compass/core)
// ============================================================================

interface NeteaseSettings {
  searchLimit: number
  audioQuality: 'standard' | 'exhigh' | 'lossless' | 'hires'
}

// ============================================================================
// LRC Parser — parse [mm:ss.xx] lyric lines
// ============================================================================

interface LyricLine {
  time: number // ms
  text: string
}

function parseLRC(lrc: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const raw of lrc.split('\n')) {
    const match = raw.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)$/)
    if (!match) continue
    const min = parseInt(match[1]!, 10)
    const sec = parseInt(match[2]!, 10)
    let ms = parseInt(match[3]!, 10)
    if (match[3]!.length === 2) ms *= 10
    const time = min * 60000 + sec * 1000 + ms
    const text = match[4]?.trim() ?? ''
    if (text) lines.push({ time, text })
  }
  return lines.sort((a, b) => a.time - b.time)
}

// ============================================================================
// Plugin Class
// ============================================================================

class NeteaseDataSourcePlugin {
  readonly id = PLUGIN_ID
  readonly name = '网易云音乐'

  private context: any = null
  private client: NeteaseApiClient | null = null
  private userId: number | null = null
  private qrPollTimer: ReturnType<typeof setInterval> | null = null

  private settings: NeteaseSettings = {
    searchLimit: 30,
    audioQuality: 'exhigh',
  }

  // DataSourceAuthInfo — enables login UI in Compass settings
  auth = {
    required: false as const,
    loginLabel: '二维码登录',
    getStatus: async (): Promise<'authenticated' | 'unauthenticated' | 'expired' | 'checking'> => {
      if (!this.client) return 'unauthenticated'
      try {
        const user = await this.client.getLoginStatus()
        return user ? 'authenticated' : 'unauthenticated'
      } catch {
        return 'expired'
      }
    },
    login: async (): Promise<boolean> => {
      await this.startQrLogin()
      return !!this.userId
    },
    logout: async (): Promise<void> => {
      await this.logout()
    },
  }

  // --- Lifecycle ---

  async activate(context: any): Promise<void> {
    this.context = context

    // Read settings
    this.settings = {
      searchLimit: (context.config.get('searchLimit') as number) ?? this.settings.searchLimit,
      audioQuality:
        ((context.config.get('audioQuality') as string) as NeteaseSettings['audioQuality']) ??
        this.settings.audioQuality,
    }

    // Init API client using plugin's cookie-isolated fetch
    this.client = new NeteaseApiClient({
      fetch: context.fetch ?? globalThis.fetch,
      log: (level, msg, ...args) => context.log(level, msg, ...args),
    })

    // Observe config changes
    context.config.observe('searchLimit', (v: number) => {
      this.settings.searchLimit = v
    })
    context.config.observe('audioQuality', (v: string) => {
      this.settings.audioQuality = v as NeteaseSettings['audioQuality']
    })

    // Register commands
    this.registerCommands(context)

    // Restore login state from credentials
    const storedUid = await context.credentials?.get('userId')
    if (storedUid) {
      this.userId = Number(storedUid)
      context.log('info', `Restored Netease session for uid: ${this.userId}`)
    }

    context.log('info', 'Netease Cloud Music plugin activated (direct mode)')
  }

  async deactivate(): Promise<void> {
    this.stopQrPoll()
    this.context?.log('info', 'Netease Cloud Music plugin deactivated')
  }

  // --- DataSource: search ---

  async search(query: string, options?: any): Promise<any[]> {
    if (!this.client) return []

    const limit = options?.limit ?? this.settings.searchLimit
    const offset = options?.offset ?? 0

    try {
      const { songs } = await this.client.search(query, { limit, offset })
      return songs.map((s) => this.trackToSearchResult(s))
    } catch (error) {
      this.context?.log('error', 'Search failed:', error)
      return []
    }
  }

  // --- DataSource: resolveStream ---

  async resolveStream(track: any): Promise<any> {
    if (!this.client) throw new Error('Plugin not initialized')

    const neteaseId = this.extractNeteaseId(track)
    if (!neteaseId) throw new Error('Missing Netease song ID')

    const urls = await this.client.getSongUrl([neteaseId], this.settings.audioQuality)
    const best = urls.find((u) => u.url)

    if (!best?.url) {
      throw new Error('该歌曲暂无音源（可能需要 VIP 或无版权）')
    }

    return {
      url: best.url,
      format: best.type || 'mp3',
      headers: {},
    }
  }

  // --- DataSource: getMetadata ---

  async getMetadata(track: any): Promise<any> {
    if (!this.client) return {}

    const neteaseId = this.extractNeteaseId(track)
    if (!neteaseId) return {}

    try {
      const songs = await this.client.getSongDetail([neteaseId])
      const song = songs[0]
      if (!song) return {}

      return {
        title: song.name,
        artist: song.ar.map((a) => a.name).join(' / '),
        album: song.al.name,
        coverUrl: song.al.picUrl ? `${song.al.picUrl}?param=512y512` : undefined,
        duration: Math.round(song.dt / 1000),
      }
    } catch (error) {
      this.context?.log('error', 'Failed to get metadata:', error)
      return {}
    }
  }

  // --- DataSource: getLyrics ---

  async getLyrics(track: any): Promise<any> {
    if (!this.client) return null

    const neteaseId = this.extractNeteaseId(track)
    if (!neteaseId) return null

    try {
      const lyricData = await this.client.getLyric(neteaseId)
      if (!lyricData.lrc?.lyric) return null

      const lines = parseLRC(lyricData.lrc.lyric)
      if (lines.length === 0) {
        return { text: lyricData.lrc.lyric }
      }

      // Parse translated lyrics if available
      let translatedLines: LyricLine[] = []
      if (lyricData.tlyric?.lyric) {
        translatedLines = parseLRC(lyricData.tlyric.lyric)
      }

      return {
        lines: lines.map((l) => {
          const tl = translatedLines.find((t) => Math.abs(t.time - l.time) < 100)
          return {
            time: l.time,
            text: l.text,
            translation: tl?.text,
          }
        }),
      }
    } catch (error) {
      this.context?.log('error', 'Failed to get lyrics:', error)
      return null
    }
  }

  // --- Commands ---

  private registerCommands(context: any): void {
    context.commands.add('global', {
      'netease:login': () => this.startQrLogin(),
      'netease:logout': () => this.logout(),
      'netease:sync-playlists': () => this.syncPlaylists(),
      'netease:check-status': () => this.showLoginStatus(),
    })
  }

  // --- QR Login ---

  private async startQrLogin(): Promise<void> {
    if (!this.client) {
      this.context?.notifications?.addError('插件未初始化')
      return
    }

    this.stopQrPoll()

    try {
      this.context?.notifications?.addInfo('正在生成登录二维码…')

      const unikey = await this.client.getQrKey()
      const qrUrl = `https://music.163.com/login?codekey=${unikey}`
      const qrSvg = await QRCode.toString(qrUrl, { type: 'svg', width: 220, margin: 2 })
      const html = this.buildQrLoginPage(qrSvg)

      // Fire-and-forget: open auth window to display QR code.
      // Login is detected via background polling, not via window redirect.
      this.context?.openAuthWindow?.(
        `data:text/html;base64,${btoa(unescape(encodeURIComponent(html)))}`,
        { width: 420, height: 520, title: '网易云音乐 — 扫码登录' },
      ).catch(() => {
        // User closed the window manually — that's fine
      })

      this.startQrPoll(unikey)
    } catch (error: any) {
      this.context?.log('error', 'QR login failed:', error)
      this.context?.notifications?.addError(`登录失败: ${error?.message ?? String(error)}`)
    }
  }

  private buildQrLoginPage(qrSvg: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      background: #1a1a2e;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    h2 { color: #e72d2c; margin-bottom: 8px; }
    p { color: #999; font-size: 14px; margin-top: 4px; }
    .qr { border-radius: 12px; margin: 16px 0; background: white; padding: 8px; width: 200px; height: 200px; }
    .qr svg { width: 200px; height: 200px; }
    .status { font-size: 13px; color: #aaa; }
  </style>
</head>
<body>
  <h2>网易云音乐</h2>
  <p>使用网易云音乐 APP 扫描二维码</p>
  <div class="qr">${qrSvg}</div>
  <p class="status" id="status">等待扫码…</p>
</body>
</html>`
  }

  private startQrPoll(unikey: string): void {
    this.stopQrPoll()

    let attempts = 0
    const MAX_ATTEMPTS = 150 // 5 minutes at 2s interval

    this.qrPollTimer = setInterval(async () => {
      attempts++
      if (attempts > MAX_ATTEMPTS) {
        this.stopQrPoll()
        this.context?.notifications?.addError('二维码已过期，请重新登录')
        return
      }

      try {
        const code = await this.client!.checkQr(unikey)

        switch (code) {
          case 800:
            this.stopQrPoll()
            this.context?.notifications?.addError('二维码已过期，请重新登录')
            break

          case 803: {
            // Login success — session cookies (MUSIC_U, __csrf) are now stored
            this.stopQrPoll()
            const user = await this.client!.getLoginStatus()
            if (user) {
              this.userId = user.userId
              await this.context?.credentials?.set('userId', String(user.userId))
              await this.context?.credentials?.set('nickname', user.nickname)
              this.context?.notifications?.addSuccess(
                `登录成功！欢迎 ${user.nickname}，请关闭二维码窗口`,
              )
              this.context?.log('info', `Netease login success: ${user.nickname} (${user.userId})`)
            } else {
              this.context?.notifications?.addError('登录成功但无法获取用户信息，请重试')
            }
            break
          }

          case 802:
            // Scanned, waiting for confirmation — do nothing, keep polling
            break

          case 801:
          default:
            // Waiting for scan — do nothing
            break
        }
      } catch (error) {
        this.context?.log('warn', 'QR poll error:', error)
      }
    }, 2000)
  }

  private stopQrPoll(): void {
    if (this.qrPollTimer) {
      clearInterval(this.qrPollTimer)
      this.qrPollTimer = null
    }
  }

  // --- Auth helpers ---

  private async showLoginStatus(): Promise<void> {
    if (!this.userId) {
      this.context?.notifications?.addInfo('未登录。使用命令 netease:login 扫码登录。')
      return
    }

    const user = await this.client!.getLoginStatus()
    if (user) {
      this.context?.notifications?.addInfo(`已登录: ${user.nickname}`)
    } else {
      this.context?.notifications?.addInfo('登录已过期，请重新登录')
      this.userId = null
    }
  }

  private async logout(): Promise<void> {
    this.userId = null
    await this.context?.credentials?.set('userId', '')
    await this.context?.credentials?.set('nickname', '')
    this.context?.notifications?.addSuccess('已退出登录')
  }

  // --- Playlist Sync ---

  async syncPlaylists(): Promise<void> {
    if (!this.client) {
      this.context?.notifications?.addError('插件未初始化')
      return
    }

    if (!this.userId) {
      this.context?.notifications?.addError('请先登录网易云账号 (netease:login)')
      return
    }

    const playlists = this.context?.playlists
    const library = this.context?.library
    if (!playlists || !library) {
      this.context?.notifications?.addError('歌单/曲库 API 不可用')
      return
    }

    try {
      this.context?.notifications?.addInfo('正在同步网易云歌单…')

      const ncmPlaylists = await this.client.getUserPlaylists(this.userId)
      let totalTracks = 0
      let syncedPlaylists = 0

      for (const ncmPl of ncmPlaylists) {
        try {
          const { songs } = await this.client.getPlaylistDetail(ncmPl.id)

          // Filter out tracks with no copyright or that require VIP
          const playable = songs.filter((s) => !s.noCopyrightRcmd)

          if (playable.length === 0) {
            this.context?.log('info', `Skipping empty/blocked playlist: ${ncmPl.name}`)
            continue
          }

          // Ingest tracks into Compass library
          const trackInputs = playable.map((s) => this.trackToInput(s))
          const compassTracks = await library.ingestTracks(trackInputs, { inLibrary: false })
          const trackIds = compassTracks.map((t: any) => t._id)

          // Create or update playlist in Compass
          await playlists.createPlaylist({
            name: ncmPl.name,
            description: ncmPl.description ?? undefined,
            trackIds,
          })

          totalTracks += trackIds.length
          syncedPlaylists++
        } catch (error: any) {
          this.context?.log('warn', `Failed to sync playlist "${ncmPl.name}":`, error?.message)
        }
      }

      this.context?.notifications?.addSuccess(
        `同步完成：${syncedPlaylists} 个歌单，${totalTracks} 首歌曲`,
      )
    } catch (error: any) {
      this.context?.log('error', 'Playlist sync failed:', error)
      this.context?.notifications?.addError(`同步失败: ${error?.message ?? String(error)}`)
    }
  }

  // --- Conversion helpers ---

  private trackToSearchResult(song: NeteaseTrack): any {
    return {
      id: String(song.id),
      title: song.name,
      artist: song.ar.map((a) => a.name).join(' / '),
      album: song.al.name,
      duration: Math.round(song.dt / 1000),
      coverUrl: song.al.picUrl ? `${song.al.picUrl}?param=256y256` : undefined,
      source: this.id,
    }
  }

  private trackToInput(song: NeteaseTrack): any {
    return {
      title: song.name,
      artist: song.ar.map((a) => a.name).join(' / '),
      album: song.al.name,
      duration: Math.round(song.dt / 1000),
      coverUrl: song.al.picUrl ? `${song.al.picUrl}?param=512y512` : undefined,
      source: {
        plugin: PLUGIN_ID,
        externalId: String(song.id),
      },
    }
  }

  private extractNeteaseId(track: any): number | null {
    const externalId = track.source?.externalId ?? track.id
    const id = Number(externalId)
    return isNaN(id) ? null : id
  }
}

const plugin = new NeteaseDataSourcePlugin()

export { NeteaseDataSourcePlugin }
export default plugin
