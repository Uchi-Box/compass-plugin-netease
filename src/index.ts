// ============================================================================
// Compass Plugin — Netease Cloud Music
// DataSource plugin: search, stream, lyrics, login, playlist sync
// Self-contained: calls music.163.com directly via weapi encryption.
// Cookies are managed automatically by the plugin's Electron session partition.
// ============================================================================

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
  private nickname: string | null = null
  private panelChangeCallback: (() => void) | null = null
  private syncing = false
  private panelDisposable: any = null

  private settings: NeteaseSettings = {
    searchLimit: 30,
    audioQuality: 'exhigh',
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
      this.nickname = (await context.credentials?.get('nickname')) || null
      context.log('info', `Restored Netease session for uid: ${this.userId}`)
    }

    // Register settings panel for login/sync UI
    this.registerSettingsPanel(context)

    context.log('info', 'Netease Cloud Music plugin activated (direct mode)')
  }

  async deactivate(): Promise<void> {
    this.panelDisposable?.dispose()
    this.context?.log('info', 'Netease Cloud Music plugin deactivated')
  }

  // --- Settings Panel ---

  private registerSettingsPanel(context: any): void {
    if (!context.registerSettingsPanel) return

    this.panelDisposable = context.registerSettingsPanel({
      render: () => this.renderSettingsPanel(),
      onDidChange: (callback: () => void) => {
        this.panelChangeCallback = callback
        return { dispose: () => { this.panelChangeCallback = null } }
      },
    })
  }

  private notifyPanelChange(): void {
    this.panelChangeCallback?.()
  }

  private renderSettingsPanel(): any[] {
    const elements: any[] = []

    if (this.userId) {
      // Logged in
      elements.push({
        type: 'status',
        label: '账号',
        value: this.nickname ?? `UID: ${this.userId}`,
        variant: 'success',
      })
      elements.push({
        type: 'button-group',
        children: [
          { type: 'button', label: '同步歌单', command: 'netease:sync-playlists', variant: 'primary', disabled: this.syncing },
          { type: 'button', label: '退出登录', command: 'netease:logout', variant: 'danger' },
        ],
      })
    } else {
      // Not logged in
      elements.push({
        type: 'status',
        label: '账号',
        value: '未登录',
      })
      elements.push({
        type: 'button',
        label: '登录',
        command: 'netease:login',
        variant: 'primary',
      })
    }

    if (this.syncing) {
      elements.push({
        type: 'text',
        content: '正在同步歌单，请稍候…',
        variant: 'muted',
      })
    }

    return elements
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
      'netease:login': () => this.login(),
      'netease:logout': () => this.logout(),
      'netease:sync-playlists': () => this.syncPlaylists(),
      'netease:check-status': () => this.showLoginStatus(),
    })
  }

  // --- Login via Auth Window ---

  private async login(): Promise<void> {
    if (!this.context?.openAuthWindow) {
      this.context?.notifications?.addError('当前平台不支持登录')
      return
    }

    try {
      // Open NetEase login page in auth window.
      // The window uses the plugin's isolated session partition,
      // so cookies (MUSIC_U, __csrf) are captured automatically.
      // User logs in via any method, then closes the window.
      await this.context.openAuthWindow(
        'https://music.163.com/#/login',
        {
          width: 900,
          height: 650,
          title: '网易云音乐 — 登录',
        },
      )
    } catch {
      // User closed window — expected behavior
    }

    // Check login status regardless of how the window was closed.
    // Cookies are already persisted in the plugin's session partition.
    const user = await this.client?.getLoginStatus()
    if (user) {
      this.userId = user.userId
      this.nickname = user.nickname
      await this.context?.credentials?.set('userId', String(user.userId))
      await this.context?.credentials?.set('nickname', user.nickname)
      this.context?.notifications?.addSuccess(`登录成功！欢迎 ${user.nickname}`)
      this.context?.log('info', `Netease login success: ${user.nickname} (${user.userId})`)
    } else if (!this.userId) {
      this.context?.notifications?.addInfo('未检测到登录，请登录后关闭窗口')
    }

    this.notifyPanelChange()
  }

  // --- Auth helpers ---

  private async showLoginStatus(): Promise<void> {
    if (!this.userId) {
      this.context?.notifications?.addInfo('未登录。使用命令 netease:login 扫码登录。')
      return
    }

    const user = await this.client!.getLoginStatus()
    if (user) {
      this.nickname = user.nickname
      this.context?.notifications?.addInfo(`已登录: ${user.nickname}`)
    } else {
      this.context?.notifications?.addInfo('登录已过期，请重新登录')
      this.userId = null
      this.nickname = null
      this.notifyPanelChange()
    }
  }

  private async logout(): Promise<void> {
    this.userId = null
    this.nickname = null
    await this.context?.credentials?.set('userId', '')
    await this.context?.credentials?.set('nickname', '')
    // Clear cookies from the plugin's session partition so the login page resets
    await this.context?.clearSessionData?.()
    this.context?.notifications?.addSuccess('已退出登录')
    this.notifyPanelChange()
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

    this.syncing = true
    this.notifyPanelChange()

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
    } finally {
      this.syncing = false
      this.notifyPanelChange()
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
