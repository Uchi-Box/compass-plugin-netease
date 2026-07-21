/// <reference lib="dom" />
declare class CommandRegistry {
	private emitter;
	private registrations;
	add(context: string, commands: Record<string, CommandHandler>): Disposable$1;
	dispatch(context: string, commandName: string, detail?: unknown): Promise<void>;
	findCommands(params?: {
		context?: string;
	}): CommandDescriptor[];
	onWillDispatch(cb: (event: CommandEvent) => void): Disposable$1;
	onDidDispatch(cb: (event: CommandEvent) => void): Disposable$1;
	dispose(): void;
	private createEvent;
}
declare class Disposable$1 implements IDisposable {
	private disposed;
	private disposalAction;
	constructor(disposalAction: () => void);
	dispose(): void;
	get isDisposed(): boolean;
}
declare class HookRegistry {
	private transforms;
	private notifications;
	addTransform<T>(hookName: string, handler: (value: T) => T | Promise<T>, options?: {
		priority?: number;
	}): Disposable$1;
	addNotification(hookName: string, handler: (value: unknown) => void | Promise<void>, options?: {
		priority?: number;
	}): Disposable$1;
	applyTransform<T>(hookName: string, initialValue: T): Promise<T>;
	notify(hookName: string, value: unknown): Promise<void>;
	dispose(): void;
}
declare class NotificationManager {
	private emitter;
	private notifications;
	addSuccess(message: string, options?: NotificationOptions$1): Notification$1;
	addInfo(message: string, options?: NotificationOptions$1): Notification$1;
	addWarning(message: string, options?: NotificationOptions$1): Notification$1;
	addError(message: string, options?: NotificationOptions$1): Notification$1;
	getNotifications(): Notification$1[];
	clear(): void;
	onDidAddNotification(cb: (notification: Notification$1) => void): Disposable$1;
	onDidClearNotifications(cb: () => void): Disposable$1;
	private add;
}
export interface AuthResult {
	url: string;
	cookies: AuthWindowCookie[];
	scriptResult?: unknown;
}
export interface AuthWindowCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
}
export interface AuthWindowOptions {
	title?: string;
	width?: number;
	height?: number;
	/** URL pattern to watch for — when navigation matches, the window closes and resolves. Supports * wildcard. */
	redirectPattern?: string;
	/** JS injected into the auth window on each page load. If it returns a non-null value, the window closes and resolves. */
	injectScript?: string;
}
export interface CompassPackageManifest {
	name: string;
	version: string;
	description?: string;
	main: string;
	compass: {
		type: "plugin" | "theme";
		/**
		 * Broad plugin classification for default capability resolution. Music
		 * sources are no longer a `pluginType` — declare `contributes.sources`
		 * instead (see ADR-0001).
		 */
		pluginType?: "mcp-tools" | "hooks" | "general";
		requestedCapabilities?: PluginCapability[];
		/** Declarative contribution points read without activating the plugin. */
		contributes?: PackageContributions;
		/**
		 * VSCode-style lazy activation triggers, e.g. `onSource:netease`,
		 * `onCommand:netease:login`, `onStartup`. Empty ⇒ activate on first use.
		 */
		activationEvents?: string[];
		config?: Record<string, unknown>;
		keymaps?: Record<string, Record<string, string>>;
		commands?: Record<string, {
			title: string;
			category?: string;
		}>;
		activationCommands?: Record<string, string[]>;
		activateOnStartup?: boolean;
		engines?: {
			compass: string;
		};
		platforms?: ("desktop" | "mobile" | "all")[];
	};
}
export interface CompassPlugin {
	activate(context: PluginContext, state?: unknown): void | Promise<void>;
	deactivate(): void | Promise<void>;
	serialize?(): unknown;
	config?: Record<string, unknown>;
}
export interface Lyrics {
	lines?: Array<{
		time: number;
		text: string;
	}>;
	text?: string;
}
export interface Package {
	name: string;
	path: string;
	manifest: CompassPackageManifest;
	/** @deprecated Plugins run in Worker; no in-process module handle. */
	mainModule?: CompassPlugin;
	state: "loaded" | "activated" | "deactivated";
	activationTime?: number;
}
/** Declarative capability contributions (VSCode-style `contributes`). */
export interface PackageContributions {
	sources?: SourceContribution[];
}
/**
 * Platform loader for plugin packages. ADR-0002: plugins run in a Worker, so
 * the loader reads ESM source text rather than `require()`-ing into the UI
 * thread. In-process `loadModule` is removed (hard break).
 */
export interface PackageLoader {
	getPackagePaths(): Promise<string[]>;
	readManifest(packagePath: string): Promise<CompassPackageManifest>;
	/** Read the plugin main module as ESM source text for Worker evaluation. */
	readModuleSource(packagePath: string, main: string): Promise<string>;
}
export interface Playlist extends BaseDocument {
	name: string;
	description?: string;
	coverUrl?: string;
	trackIds: string[];
	isSmartPlaylist?: boolean;
	smartQuery?: string;
	/** Whether this playlist has automatic cloud sync enabled (Pro only). */
	cloudSync?: boolean;
	/** User-defined sort order for sidebar display. */
	order?: number;
}
export interface PluginConfigContext {
	get<T>(key: string): T;
	set(key: string, value: unknown): void;
	observe<T>(key: string, callback: (value: T) => void): Disposable$1;
	onDidChange<T>(key: string, callback: (change: {
		oldValue: T;
		newValue: T;
	}) => void): Disposable$1;
}
export interface PluginContext {
	readonly pluginId: string;
	readonly manifest: CompassPackageManifest;
	readonly platform: "desktop" | "mobile";
	/**
	 * VSCode-style unified cleanup: Disposables pushed here are disposed when the
	 * plugin deactivates. Plugins should push everything they register.
	 */
	readonly subscriptions: Disposable$1[];
	readonly commands: Pick<CommandRegistry, "add" | "dispatch" | "findCommands">;
	readonly notifications: Pick<NotificationManager, "addSuccess" | "addInfo" | "addWarning" | "addError">;
	readonly config: PluginConfigContext;
	readonly hooks: Pick<HookRegistry, "addTransform" | "addNotification">;
	readonly storage?: {
		getStore(): unknown;
	};
	readonly mcp?: {
		registerServer(server: unknown): Disposable$1;
	};
	readonly themes?: {
		registerTheme(theme: unknown): Disposable$1;
	};
	readonly tools?: {
		register(tool: PluginToolRegistration): Disposable$1;
	};
	readonly sources?: PluginSourcesFacade;
	readonly net?: PluginNetFacade;
	readonly secrets?: PluginCredentialStore;
	readonly ingest?: PluginIngestFacade;
	readonly library?: PluginLibraryFacade;
	readonly playlists?: PluginPlaylistFacade;
	readonly playback?: PluginPlaybackFacade;
	readonly registerSettingsPanel?: (renderer: SettingsPanelRenderer) => Disposable$1;
	log(level: "info" | "warn" | "error", message: string, ...args: unknown[]): void;
}
export interface PluginCredentialStore {
	get(key: string): Promise<string | null>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}
/**
 * Narrowed ingest facade (capability `ingest`) — the only library write a
 * source plugin gets by default. Full `library` remains an explicit opt-in.
 */
export interface PluginIngestFacade {
	ingestTracks(inputs: TrackInput[], options?: {
		inLibrary?: boolean;
	}): Promise<Track[]>;
}
/** Library operations exposed to plugins. */
export interface PluginLibraryFacade {
	getTrack(trackId: string): Promise<Track>;
	searchTracks(query: string): Promise<Track[]>;
	getLibraryTracks(): Promise<Track[]>;
	getAllTracks(): Promise<Track[]>;
	ingestTracks(inputs: TrackInput[], options?: {
		inLibrary?: boolean;
	}): Promise<Track[]>;
	addToLibrary(trackIds: string[]): Promise<void>;
	removeFromLibrary(trackIds: string[]): Promise<void>;
	favoriteTrack(trackId: string): Promise<void>;
	unfavoriteTrack(trackId: string): Promise<void>;
	isFavorite(trackId: string): Promise<boolean>;
}
/**
 * Network facade (capability `net`) — CORS-free fetch scoped to the plugin's
 * own session, plus auth-window and protocol helpers.
 */
export interface PluginNetFacade {
	fetch(url: string, options?: RequestInit): Promise<Response>;
	openAuthWindow?(url: string, opts?: AuthWindowOptions): Promise<AuthResult>;
	clearSessionData?(): Promise<void>;
	registerProtocol?(scheme: string, handler: ProtocolHandler): void;
}
/** Playback controls exposed to plugins. */
export interface PluginPlaybackFacade {
	getSnapshot(): PlaybackSnapshot;
	playTrack(trackId: string, options?: PlayTrackOptions): Promise<void>;
	play(): Promise<void>;
	pause(): Promise<void>;
	skipNext(): Promise<void>;
	skipPrevious(): Promise<void>;
	stop(): void;
	seek(ms: number): Promise<void>;
	setVolume(volume: number): void;
	getVolume(): number;
	enqueue(trackIds: string[], options?: EnqueueOptions): Promise<void>;
	onDidChange(cb: (snapshot: PlaybackSnapshot) => void): Disposable$1;
}
/** Playlist operations exposed to plugins. */
export interface PluginPlaylistFacade {
	createPlaylist(input: {
		name: string;
		description?: string;
		trackIds?: string[];
	}): Promise<Playlist>;
	getPlaylist(playlistId: string): Promise<Playlist>;
	getAllPlaylists(): Promise<Playlist[]>;
	addTracks(playlistId: string, trackIds: string[], options?: {
		position?: number;
	}): Promise<void>;
	removeTracks(playlistId: string, trackIds: string[]): Promise<void>;
	deletePlaylist(playlistId: string): Promise<void>;
}
/**
 * Source registration facade (capability `sources`). A plugin registers one or
 * more `SourceProvider`s for the ids it declared in `contributes.sources`.
 */
export interface PluginSourcesFacade {
	register(sourceId: string, provider: SourceProvider): Disposable$1;
}
export interface PluginToolRegistration {
	/** Tool name (without plugin prefix — it's added automatically). */
	name: string;
	description: string;
	/** JSON Schema for tool parameters. */
	parameters: Record<string, unknown>;
	/** Permission level. Defaults to 'safe'. */
	permission?: PermissionLevel;
	handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}
export interface ProtocolRequest {
	url: string;
	headers: Record<string, string>;
}
export interface ProtocolResponse {
	data: ArrayBuffer | ReadableStream | Response;
	headers?: Record<string, string>;
	statusCode?: number;
}
export interface SearchOptions {
	limit?: number;
	offset?: number;
}
export interface SettingsPanelButtonElement {
	type: "button";
	label: string;
	/** Command name to dispatch when clicked (e.g. 'netease:login') */
	command: string;
	variant?: "primary" | "danger";
	disabled?: boolean;
}
export interface SettingsPanelButtonGroupElement {
	type: "button-group";
	children: SettingsPanelButtonElement[];
}
export interface SettingsPanelDividerElement {
	type: "divider";
}
export interface SettingsPanelProgressElement {
	type: "progress";
	value: number;
	max: number;
	label?: string;
}
/** Renderer returned by plugins for custom settings panel UI. */
export interface SettingsPanelRenderer {
	/** Called by the host to get the current declarative UI tree. */
	render(): SettingsPanelElement[];
	/** Subscribe to state changes — host re-renders when callback fires. */
	onDidChange?(callback: () => void): Disposable$1;
}
export interface SettingsPanelStatusElement {
	type: "status";
	label: string;
	value: string;
	variant?: "success" | "warning" | "error";
}
export interface SettingsPanelTextElement {
	type: "text";
	content: string;
	variant?: "muted";
}
/**
 * Optional auth provider for a source that requires login.
 * Modeled after VSCode's AuthenticationProvider: the source drives login via
 * host-provided net/secrets facades internally.
 */
export interface SourceAuthProvider {
	/** Human-readable label for the login method (e.g., "QR Code", "SMS", "Cookie"). */
	loginLabel?: string;
	getStatus(): Promise<AuthStatus>;
	/** Initiate login flow. Returns true on success. */
	login(): Promise<boolean>;
	/** Log out — clear stored credentials and session cookies. */
	logout(): Promise<void>;
}
/**
 * Declarative source metadata from a plugin manifest's `contributes.sources`.
 * Read by the host without activating the plugin (used for listing, platform
 * policy filtering, and deriving `onSource:<id>` activation events).
 */
export interface SourceContribution {
	id: string;
	name: string;
	auth?: "none" | "optional" | "required";
	platforms?: ("desktop" | "mobile" | "all")[];
	capabilities?: string[];
}
/**
 * Pure data interface a plugin registers via `context.sources.register(id, provider)`.
 * Decoupled from the plugin lifecycle object (activate/deactivate). A plugin may
 * register 0..N providers. All methods are async and return serializable values so
 * the provider can run behind the Worker RPC boundary (see ADR-0002).
 */
export interface SourceProvider {
	search(query: string, options?: SearchOptions): Promise<SourceSearchResult[]>;
	resolveStream(ref: TrackRef): Promise<StreamInfo>;
	getMetadata?(ref: TrackRef): Promise<TrackMetadata | null>;
	getLyrics?(ref: TrackRef): Promise<Lyrics | null>;
	auth?: SourceAuthProvider;
}
export interface SourceSearchResult {
	ref: TrackRef;
	title: string;
	artist: string;
	album?: string;
	coverUrl?: string;
	duration?: number;
}
/** Resolved audio stream information. */
export interface StreamInfo {
	url: string;
	format: AudioFormat;
	bitrate?: number;
	fileSize?: number;
	headers?: Record<string, string>;
}
export interface Track extends BaseDocument {
	title: string;
	artist?: string;
	album?: string;
	duration?: number;
	coverUrl?: string;
	/** R2 cloud path for an uploaded cover image. */
	coverCloudPath?: string;
	source: TrackSource;
	genre?: string;
	year?: number;
	trackNumber?: number;
	discNumber?: number;
	localPath?: string;
	cloudPath?: string;
	/** File size in bytes when uploaded to cloud storage. */
	cloudSize?: number;
	/** Whether the track is in the user's library. Default false (ephemeral). */
	inLibrary?: boolean;
	playCount: number;
	tags?: string[];
}
export interface TrackInput {
	title: string;
	artist?: string;
	album?: string;
	duration?: number;
	coverUrl?: string;
	genre?: string;
	year?: number;
	trackNumber?: number;
	discNumber?: number;
	source: {
		plugin: string;
		externalId: string;
		streamUrl?: string;
	};
	localPath?: string;
	tags?: string[];
}
export interface TrackMetadata {
	title?: string;
	artist?: string;
	album?: string;
	coverUrl?: string;
	duration?: number;
	genre?: string;
	year?: number;
	trackNumber?: number;
	discNumber?: number;
}
/**
 * Canonical reference to a track within a source.
 * Unifies the previously-split `source: string` + `id` search shape and the
 * `{ plugin, externalId }` persisted shape into one API-facing type.
 */
export interface TrackRef {
	/** Source id (= `contributes.sources[].id`, = persisted `Track.source.plugin`). */
	source: string;
	/** External id within that source (= persisted `Track.source.externalId`). */
	id: string;
}
export interface TrackSource {
	plugin: string;
	externalId: string;
	streamUrl?: string;
}
export type AudioFormat = "mp3" | "m4a" | "flac" | "ogg" | "webm" | "wav";
export type AuthStatus = "authenticated" | "unauthenticated" | "expired" | "checking";
export type PluginCapability = "commands" | "notifications" | "config" | "hooks" | "pluginStore" | "playback" | "playlists" | "library" | "ingest" | "sources" | "net" | "secrets" | "mcp" | "tools" | "themes";
export type ProtocolHandler = (request: ProtocolRequest) => Promise<ProtocolResponse> | ProtocolResponse;
export type SettingsPanelElement = SettingsPanelStatusElement | SettingsPanelButtonElement | SettingsPanelButtonGroupElement | SettingsPanelTextElement | SettingsPanelDividerElement | SettingsPanelProgressElement;
interface BaseDocument {
	_id: string;
	_rev?: string;
	createdAt: string;
	updatedAt: string;
}
interface CommandDescriptor {
	name: string;
	context: string;
	handler: CommandHandler;
}
interface CommandEvent<TDetail = unknown> {
	type: string;
	context: string;
	detail?: TDetail;
	stopPropagation(): void;
	defaultPrevented: boolean;
	preventDefault(): void;
}
interface EnqueueOptions {
	position?: "next" | "end";
}
interface IDisposable {
	dispose(): void;
}
interface Notification$1 {
	type: NotificationType;
	message: string;
	options: NotificationOptions$1;
	timestamp: number;
	dismissed: boolean;
	dismiss(): void;
	onDidDismiss(cb: () => void): Disposable$1;
}
interface NotificationOptions$1 {
	detail?: string;
	description?: string;
	dismissable?: boolean;
	icon?: string;
	buttons?: Array<{
		text: string;
		onDidClick: () => void;
	}>;
}
interface PlayTrackOptions {
	/** Replace queue with these track IDs. */
	queue?: string[];
	/** Source identifier (e.g., plugin name, 'search', 'playlist:{id}'). */
	source?: string;
}
interface PlaybackSnapshot {
	status: "idle" | "playing" | "paused" | "loading" | "error";
	currentTrackId: string | null;
	queueTrackIds: string[];
	currentIndex: number;
	progressMs: number;
	durationMs: number;
	bufferedMs: number;
	playMode: PlayMode;
	volume: number;
	error?: string;
}
interface ToolResult {
	content?: unknown;
	error?: string;
}
type CommandHandler<TDetail = unknown> = (event: CommandEvent<TDetail>) => void | Promise<void>;
type NotificationType = "success" | "info" | "warning" | "error";
type PermissionLevel = "safe" | "moderate" | "sensitive";
type PlayMode = "sequential" | "shuffle" | "repeat-one" | "repeat-all";

export {};
