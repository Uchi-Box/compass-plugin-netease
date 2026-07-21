// ============================================================================
// Compass Plugin — Netease Cloud Music
// Source plugin: search, stream, lyrics, login, playlist sync.
// Self-contained: calls music.163.com directly via weapi encryption.
// Cookies are managed automatically by the plugin's isolated session partition.
// ============================================================================

import type {
  AuthStatus,
  Lyrics,
  PluginContext,
  SearchOptions,
  SettingsPanelRenderer,
  SourceAuthProvider,
  SourceProvider,
  SourceSearchResult,
  StreamInfo,
  TrackInput,
  TrackMetadata,
  TrackRef
} from './compass-plugin-api'
import { NeteaseApiClient, type NeteaseTrack } from './api-client'

/** Source id — matches `contributes.sources[].id` in package.json. */
const SOURCE_ID = 'netease'

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

/** Normalize Netease's stream `type` string into a Compass AudioFormat. */
function toAudioFormat(type: string | undefined): StreamInfo['format'] {
  switch ((type ?? '').toLowerCase()) {
    case 'flac':
      return 'flac'
    case 'm4a':
      return 'm4a'
    case 'ogg':
      return 'ogg'
    default:
      return 'mp3'
  }
}

// ============================================================================
// Plugin — lifecycle object. Registers a SourceProvider on activate().
// ============================================================================

class NeteasePlugin {
  private context: PluginContext | null = null
  private client: NeteaseApiClient | null = null
  private userId: number | null = null
  private nickname: string | null = null
  private panelChangeCallback: (() => void) | null = null
  private syncing = false

  private settings: NeteaseSettings = {
    searchLimit: 30,
    audioQuality: 'exhigh'
  }

  // --- Lifecycle ---

  async activate(context: PluginContext): Promise<void> {
    this.context = context

    // Read settings
    this.settings = {
      searchLimit: context.config.get<number>('searchLimit') ?? this.settings.searchLimit,
      audioQuality:
        context.config.get<NeteaseSettings['audioQuality']>('audioQuality') ??
        this.settings.audioQuality
    }

    // Init API client using the plugin's cookie-isolated fetch (capability `net`)
    this.client = new NeteaseApiClient({
      fetch: context.net?.fetch ?? globalThis.fetch,
      log: (level, msg, ...args) => context.log(level, msg, ...args)
    })

    // Observe config changes
    context.config.observe<number>('searchLimit', v => {
      this.settings.searchLimit = v
    })
    context.config.observe<NeteaseSettings['audioQuality']>('audioQuality', v => {
      this.settings.audioQuality = v
    })

    // Register the music source (capability `sources`)
    const provider: SourceProvider = {
      search: (q, opts) => this.search(q, opts),
      resolveStream: ref => this.resolveStream(ref),
      getMetadata: ref => this.getMetadata(ref),
      getLyrics: ref => this.getLyrics(ref),
      auth: this.createAuthProvider()
    }
    if (!context.sources) throw new Error('Netease plugin requires the `sources` capability')
    context.subscriptions.push(context.sources.register(SOURCE_ID, provider))

    // Register commands (used by the settings-panel buttons)
    this.registerCommands(context)

    // Restore login state from encrypted secrets (capability `secrets`)
    const storedUid = await context.secrets?.get('userId')
    if (storedUid) {
      this.userId = Number(storedUid)
      this.nickname = (await context.secrets?.get('nickname')) || null
      context.log('info', `Restored Netease session for uid: ${this.userId}`)
    }

    // Register settings panel for login/sync UI (desktop only)
    this.registerSettingsPanel(context)

    context.log('info', 'Netease Cloud Music plugin activated')
  }

  async deactivate(): Promise<void> {
    // Disposables (source + settings panel) are cleaned up via context.subscriptions.
    this.context?.log('info', 'Netease Cloud Music plugin deactivated')
  }

  // --- Auth (SourceAuthProvider) ---

  private createAuthProvider(): SourceAuthProvider {
    return {
      loginLabel: '网页登录',
      getStatus: () => this.getAuthStatus(),
      login: () => this.login(),
      logout: () => this.logout()
    }
  }

  private async getAuthStatus(): Promise<AuthStatus> {
    if (!this.userId) return 'unauthenticated'
    const user = await this.client?.getLoginStatus()
    if (user) {
      this.nickname = user.nickname
      return 'authenticated'
    }
    return 'expired'
  }

  // --- Settings Panel ---

  private registerSettingsPanel(context: PluginContext): void {
    if (!context.registerSettingsPanel) return

    // The host's SettingsPanelRenderer.onDidChange is typed to return the
    // concrete Disposable class; a structural { dispose } is fine at runtime.
    const renderer = {
      render: () => this.renderSettingsPanel(),
      onDidChange: (callback: () => void) => {
        this.panelChangeCallback = callback
        return {
          dispose: () => {
            this.panelChangeCallback = null
          }
        }
      }
    } as unknown as SettingsPanelRenderer

    const disposable = context.registerSettingsPanel(renderer)
    context.subscriptions.push(disposable)
  }

  private notifyPanelChange(): void {
    this.panelChangeCallback?.()
  }

  private renderSettingsPanel() {
    const elements = []

    if (this.userId) {
      // Logged in
      elements.push({
        type: 'status' as const,
        label: '账号',
        value: this.nickname ?? `UID: ${this.userId}`,
        variant: 'success' as const
      })
      elements.push({
        type: 'button-group' as const,
        children: [
          {
            type: 'button' as const,
            label: '同步歌单',
            command: 'netease:sync-playlists',
            variant: 'primary' as const,
            disabled: this.syncing
          },
          {
            type: 'button' as const,
            label: '退出登录',
            command: 'netease:logout',
            variant: 'danger' as const
          }
        ]
      })
    } else {
      // Not logged in
      elements.push({
        type: 'status' as const,
        label: '账号',
        value: '未登录'
      })
      elements.push({
        type: 'button' as const,
        label: '登录',
        command: 'netease:login',
        variant: 'primary' as const
      })
    }

    if (this.syncing) {
      elements.push({
        type: 'text' as const,
        content: '正在同步歌单，请稍候…',
        variant: 'muted' as const
      })
    }

    return elements
  }

  // --- SourceProvider ---

  async search(query: string, options?: SearchOptions): Promise<SourceSearchResult[]> {
    if (!this.client) return []

    const limit = options?.limit ?? this.settings.searchLimit
    const offset = options?.offset ?? 0

    try {
      const { songs } = await this.client.search(query, { limit, offset })
      return songs.map(s => this.trackToSearchResult(s))
    } catch (error) {
      this.context?.log('error', 'Search failed:', error)
      return []
    }
  }

  async resolveStream(ref: TrackRef): Promise<StreamInfo> {
    if (!this.client) throw new Error('Plugin not initialized')

    const neteaseId = this.extractNeteaseId(ref)
    if (!neteaseId) throw new Error('Missing Netease song ID')

    const urls = await this.client.getSongUrl([neteaseId], this.settings.audioQuality)
    const best = urls.find(u => u.url)

    if (!best?.url) {
      throw new Error('该歌曲暂无音源（可能需要 VIP 或无版权）')
    }

    return {
      url: best.url,
      format: toAudioFormat(best.type),
      headers: {}
    }
  }

  async getMetadata(ref: TrackRef): Promise<TrackMetadata | null> {
    if (!this.client) return null

    const neteaseId = this.extractNeteaseId(ref)
    if (!neteaseId) return null

    try {
      const songs = await this.client.getSongDetail([neteaseId])
      const song = songs[0]
      if (!song) return null

      return {
        title: song.name,
        artist: song.ar.map(a => a.name).join(' / '),
        album: song.al.name,
        coverUrl: song.al.picUrl ? `${song.al.picUrl}?param=512y512` : undefined,
        duration: Math.round(song.dt / 1000)
      }
    } catch (error) {
      this.context?.log('error', 'Failed to get metadata:', error)
      return null
    }
  }

  async getLyrics(ref: TrackRef): Promise<Lyrics | null> {
    if (!this.client) return null

    const neteaseId = this.extractNeteaseId(ref)
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
        lines: lines.map(l => {
          const tl = translatedLines.find(t => Math.abs(t.time - l.time) < 100)
          return {
            time: l.time,
            text: tl?.text ? `${l.text}\n${tl.text}` : l.text
          }
        })
      }
    } catch (error) {
      this.context?.log('error', 'Failed to get lyrics:', error)
      return null
    }
  }

  // --- Commands ---

  private registerCommands(context: PluginContext): void {
    context.commands.add('global', {
      'netease:login': () => {
        void this.login()
      },
      'netease:logout': () => this.logout(),
      'netease:sync-playlists': () => this.syncPlaylists(),
      'netease:check-status': () => this.showLoginStatus()
    })
  }

  // --- Login via Auth Window ---

  private async login(): Promise<boolean> {
    if (!this.context?.net?.openAuthWindow) {
      this.context?.notifications?.addError('当前平台不支持登录')
      return false
    }

    try {
      // Open NetEase login page in an auth window scoped to the plugin's
      // isolated session partition, so cookies (MUSIC_U, __csrf) are captured
      // automatically. User logs in via any method, then closes the window.
      await this.context.net.openAuthWindow('https://music.163.com/#/login', {
        width: 900,
        height: 650,
        title: '网易云音乐 — 登录'
      })
    } catch {
      // User closed window — expected behavior
    }

    // Check login status regardless of how the window was closed.
    const user = await this.client?.getLoginStatus()
    if (user) {
      this.userId = user.userId
      this.nickname = user.nickname
      await this.context?.secrets?.set('userId', String(user.userId))
      await this.context?.secrets?.set('nickname', user.nickname)
      this.context?.notifications?.addSuccess(`登录成功！欢迎 ${user.nickname}`)
      this.context?.log('info', `Netease login success: ${user.nickname} (${user.userId})`)
      this.notifyPanelChange()
      return true
    }

    if (!this.userId) {
      this.context?.notifications?.addInfo('未检测到登录，请登录后关闭窗口')
    }
    this.notifyPanelChange()
    return false
  }

  private async showLoginStatus(): Promise<void> {
    if (!this.userId) {
      this.context?.notifications?.addInfo('未登录。使用命令 netease:login 登录。')
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
    await this.context?.secrets?.delete('userId')
    await this.context?.secrets?.delete('nickname')
    // Clear cookies from the plugin's session partition so the login page resets
    await this.context?.net?.clearSessionData?.()
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
    const ingest = this.context?.ingest
    if (!playlists || !ingest) {
      this.context?.notifications?.addError('歌单/ingest API 不可用')
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
          const playable = songs.filter(s => !s.noCopyrightRcmd)

          if (playable.length === 0) {
            this.context?.log('info', `Skipping empty/blocked playlist: ${ncmPl.name}`)
            continue
          }

          // Ingest tracks into Compass library (capability `ingest`)
          const trackInputs = playable.map(s => this.trackToInput(s))
          const compassTracks = await ingest.ingestTracks(trackInputs, { inLibrary: false })
          const trackIds = compassTracks.map(t => t._id)

          // Create the playlist in Compass
          await playlists.createPlaylist({
            name: ncmPl.name,
            description: ncmPl.description ?? undefined,
            trackIds
          })

          totalTracks += trackIds.length
          syncedPlaylists++
        } catch (error) {
          this.context?.log(
            'warn',
            `Failed to sync playlist "${ncmPl.name}":`,
            error instanceof Error ? error.message : String(error)
          )
        }
      }

      this.context?.notifications?.addSuccess(
        `同步完成：${syncedPlaylists} 个歌单，${totalTracks} 首歌曲`
      )
    } catch (error) {
      this.context?.log('error', 'Playlist sync failed:', error)
      this.context?.notifications?.addError(
        `同步失败: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      this.syncing = false
      this.notifyPanelChange()
    }
  }

  // --- Conversion helpers ---

  private trackToSearchResult(song: NeteaseTrack): SourceSearchResult {
    return {
      ref: { source: SOURCE_ID, id: String(song.id) },
      title: song.name,
      artist: song.ar.map(a => a.name).join(' / '),
      album: song.al.name,
      duration: Math.round(song.dt / 1000),
      coverUrl: song.al.picUrl ? `${song.al.picUrl}?param=256y256` : undefined
    }
  }

  private trackToInput(song: NeteaseTrack): TrackInput {
    return {
      title: song.name,
      artist: song.ar.map(a => a.name).join(' / '),
      album: song.al.name,
      duration: Math.round(song.dt / 1000),
      coverUrl: song.al.picUrl ? `${song.al.picUrl}?param=512y512` : undefined,
      source: {
        plugin: SOURCE_ID,
        externalId: String(song.id)
      }
    }
  }

  private extractNeteaseId(ref: TrackRef): number | null {
    const id = Number(ref?.id)
    return Number.isNaN(id) ? null : id
  }
}

const plugin = new NeteasePlugin()

export { NeteasePlugin }
export default plugin
