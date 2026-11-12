import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { FormSwitch } from "@components/FormSwitch";
import { copyWithToast } from "@utils/discord";
import definePlugin from "@utils/types";
import { findByPropsLazy, findLazy, findStoreLazy } from "@webpack";
import type { RenderModalProps } from "@vencord/discord-types";
import {
    Alerts,
    GuildStore,
    Menu,
    Modal,
    NavigationRouter,
    openModal,
    React,
    RestAPI,
    showToast,
    Text,
    Tooltip,
    UserStore,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "@webpack/common";
import type { ComponentType, UIEvent } from "react";

import { FosscordAuthor } from "../fosscordCore/shared";
import { ensureGuild, joinRemote, UNLOADED_MESSAGE } from "./join";
import {
    addRemoteFriend,
    chatInviteKey,
    errorText,
    friendInput,
    friendLink,
    globalHandle,
    guildInstance,
    instanceName,
    inviteEndpoint,
    isHandle,
    joinInviteKey,
    keepInviteKey,
    loadGuildInstances,
    loadInstances,
    nameOf,
    noteInviteError,
    queueGuild,
    rememberGuild,
    remoteError,
    remoteKey,
    userInstance,
} from "./remote";
import managedStyle from "./style.css?managed";

const TAB = "fosscord-other-instances";
const SECTION = "FOSSCORD_OTHER_INSTANCES";
const GuildSettingsStore = findStoreLazy("GuildSettingsStore") as { getGuildId(): string | null };
const GatewayConnectionStore = findStoreLazy("GatewayConnectionStore") as {
    getSocket(): { dispatcher?: { receiveDispatch(data: unknown, type: string, compression?: unknown): void } } | null;
};
const SERVERS = "servers";

type FieldStore<T> = { getState(): T; setState(state: Partial<T>): void; resetState(): void; useField<K extends keyof T>(key: K): T[K] };
type ServersState = { selectedTab: string | null };
const stateHas = (store: { getState?: unknown } | null | undefined, keys: string[]) => {
    if (typeof store?.getState !== "function") return false;
    try {
        const state = (store.getState as () => unknown)();
        return !!state && typeof state === "object" && keys.every((key) => key in state);
    } catch {
        return false;
    }
};
const ServersTabStore = findLazy(
    (m) => typeof m?.useField === "function" && stateHas(m, ["selectedTab", "isSearchVisible", "searchBarState", "entrypoint"]),
) as FieldStore<ServersState>;
const ServersQueryStore = findLazy((m) => typeof m?.useField === "function" && stateHas(m, ["fetchedQuery", "resultsQuery", "categoryId"])) as FieldStore<object>;
const GlobalDiscovery = findByPropsLazy("transitionToGlobalDiscovery") as { transitionToGlobalDiscovery(options: { tab: string; selectedServersTab?: string }): void };

type Registration = "open" | "invite" | "approval" | "closed";
type RemoteInstance = { id: string; name: string; description: string; icon_url: string | null; url: string; registration: Registration; state: string; guild_count?: number };
type RemoteGuild = {
    id: string;
    instance: string;
    instance_name: string;
    instance_icon_url: string | null;
    name: string;
    description: string;
    icon_url: string | null;
    splash_url?: string | null;
    member_count: number;
    presence_count: number | null;
    active_at?: string | null;
    created_at?: string | null;
    verified: boolean;
    invite_url: string;
    has_welcome?: boolean;
    rule_count?: number;
    joined_guild_id?: string | null;
};
type WelcomeChannel = { name: string; description: string; emoji_name: string | null; emoji_url: string | null };
type GuildDetails = RemoteGuild & {
    welcome?: { description: string; channels: WelcomeChannel[] } | null;
    rules?: string[] | null;
    instance_description?: string;
    instance_url?: string | null;
    instance_registration?: Registration | null;
};
type Directory =
    | { available: false; reason: string }
    | {
          available: true;
          verification: "registry" | "instance";
          instances: RemoteInstance[];
          guilds: RemoteGuild[];
          total: number;
          offset: number;
          limit: number;
          match_counts?: Record<string, number> | null;
      };
type FederatedVoiceIds = { daveId(userId: string): string; localId(daveId: string): string; daveGroup(channelId: bigint): bigint };
type DaveSession = {
    Init(version: number, groupId: bigint, userId: string, key: unknown): unknown;
    ProcessProposals(proposals: unknown, userIds: string[]): unknown;
    ProcessWelcome(welcome: unknown, userIds: string[]): unknown;
    ProcessCommit(commit: unknown): unknown;
    GetKeyRatchet(userId: string): unknown;
    GetPairwiseFingerprint(version: number, userId: string, ...rest: unknown[]): unknown;
};
type OwnerState = {
    enabled: boolean;
    hidden: boolean;
    status: "off" | "hidden" | "no_invite" | "unverified" | "pending" | "verified" | "blocked" | "unknown";
    canonical_id: string | null;
    invite_url: string | null;
    federation_enabled: boolean;
    registry_live: boolean;
};

const number = new Intl.NumberFormat();
const REGISTRATION: Record<Registration, string> = {
    open: "Open signups",
    invite: "Invite only",
    approval: "Signups need approval",
    closed: "Signups closed",
};
const STATUS: Record<OwnerState["status"], string> = {
    off: "Only people on this instance can find this server in Discovery.",
    hidden: "This instance's admins hid this server from other instances. Ask them if you think that's a mistake.",
    no_invite: "This server needs a text channel before it can show on other instances.",
    unverified: "Waiting for this instance's admins to verify it. Once they do, people on other instances can find it in Discovery.",
    pending: "Verified by this instance's admins. Other instances show it once the registry picks it up, within an hour.",
    verified: "Listed. People on other instances can find this server in Discovery.",
    blocked: "The registry blocked this server, so other instances don't show it.",
    unknown: "This instance hasn't reached the federation registry yet, so other instances can't see this server for now.",
};

function Initials({ name, className, count = 2 }: { name: string; className: string; count?: number }) {
    const letters = name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, count)
        .map((word) => [...word][0])
        .join("");
    return (
        <span className={`${className} fosscord-federation-initials`} aria-hidden="true">
            {letters || "?"}
        </span>
    );
}

function Icon({ src, name, className, letters }: { src: string | null; name: string; className: string; letters?: number }) {
    const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
    return (
        <span className={`${className} fosscord-federation-icon`}>
            <Initials name={name} className="fosscord-federation-icon-fill" count={letters} />
            {src && state !== "failed" && (
                <img
                    className="fosscord-federation-icon-fill"
                    data-loaded={state === "loaded"}
                    src={src}
                    alt=""
                    loading="lazy"
                    onLoad={() => setState("loaded")}
                    onError={() => setState("failed")}
                />
            )}
        </span>
    );
}

function inviteCode(inviteUrl: string) {
    try {
        return new URL(inviteUrl).pathname.split("/").filter(Boolean).pop() ?? null;
    } catch {
        return null;
    }
}

function receiveGuild(guild: Record<string, unknown>) {
    const dispatcher = GatewayConnectionStore.getSocket()?.dispatcher;
    if (!dispatcher) throw new Error("The gateway isn't connected");
    dispatcher.receiveDispatch(structuredClone(guild), "GUILD_CREATE");
}

const hasGuild = (guildId: string) => !!GuildStore.getGuild(guildId);

function VerifiedMark() {
    return (
        <span className="fosscord-federation-verified" title="Verified by the federation registry" role="img" aria-label="Verified by the federation registry">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                    fill="currentColor"
                    d="M8 .9 9.8 2.3l2.3-.1.7 2.2 1.9 1.3-.7 2.2.7 2.2-1.9 1.3-.7 2.2-2.3-.1L8 15.1l-1.8-1.4-2.3.1-.7-2.2-1.9-1.3.7-2.2-.7-2.2 1.9-1.3.7-2.2 2.3.1Z"
                />
                <path
                    fill="none"
                    stroke="var(--fosscord-federation-verified-check, #fff)"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="m5.3 8.1 1.8 1.8 3.6-3.7"
                />
            </svg>
        </span>
    );
}

const searchWords = (text: string) =>
    text
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .slice(0, 6);

function Highlight({ text, words }: { text: string; words: string[] }) {
    if (!words.length) return <>{text}</>;
    const parts = text.split(/([\p{L}\p{N}\p{M}]+)/u);
    return (
        <>
            {parts.map((part, index) => {
                const plain = part
                    .normalize("NFKD")
                    .replace(/\p{M}+/gu, "")
                    .toLowerCase();
                return index % 2 === 1 && words.some((word) => plain.startsWith(word)) ? (
                    <mark key={index} className="fosscord-federation-mark">
                        {part}
                    </mark>
                ) : (
                    part
                );
            })}
        </>
    );
}

function Banner({ guild, className }: { guild: RemoteGuild; className: string }) {
    const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
    const src = guild.splash_url ?? guild.icon_url;
    return (
        <div className={`${className} fosscord-federation-banner`} aria-hidden="true">
            {src && state !== "failed" && (
                <img
                    className={guild.splash_url ? "fosscord-federation-banner-image" : "fosscord-federation-banner-image fosscord-federation-banner-blur"}
                    data-loaded={state === "loaded"}
                    src={src}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onLoad={() => setState("loaded")}
                    onError={() => setState("failed")}
                />
            )}
        </div>
    );
}

function CheckIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m2.5 6.2 2.3 2.3 4.7-4.9" />
        </svg>
    );
}

function Counts({ guild }: { guild: RemoteGuild }) {
    return (
        <div className="fosscord-federation-meta">
            {guild.presence_count != null && (
                <span className="fosscord-federation-stat">
                    <span className="fosscord-federation-dot fosscord-federation-dot-online" aria-hidden="true" />
                    <Text variant="text-xs/normal" color="text-muted" className="fosscord-federation-number">
                        {number.format(guild.presence_count)} online
                    </Text>
                </span>
            )}
            <span className="fosscord-federation-stat">
                <span className="fosscord-federation-dot" aria-hidden="true" />
                <Text variant="text-xs/normal" color="text-muted" className="fosscord-federation-number">
                    {number.format(guild.member_count)} {guild.member_count === 1 ? "member" : "members"}
                </Text>
            </span>
        </div>
    );
}

const isJoined = (guild: RemoteGuild) => !!guild.joined_guild_id && hasGuild(guild.joined_guild_id);

type GuildCardProps = { guild: RemoteGuild; words: string[]; compact?: boolean };
let memoCard: ComponentType<GuildCardProps> | null = null;

function GuildCard(props: GuildCardProps) {
    const Card = (memoCard ??= React.memo(GuildCardView));
    return <Card {...props} />;
}

function GuildCardView({ guild, words, compact = false }: GuildCardProps) {
    const joined = isJoined(guild);
    const titleId = `fosscord-federation-card-${compact ? "search-" : ""}${guild.id}`;
    return (
        <article className={`fosscord-federation-card fosscord-federation-guild${compact ? " fosscord-federation-guild-compact" : ""}`} aria-labelledby={titleId}>
            <Banner guild={guild} className="fosscord-federation-guild-banner" />
            {joined && (
                <span className="fosscord-federation-joined">
                    <CheckIcon />
                    You're a member
                </span>
            )}
            <div className="fosscord-federation-guild-body">
                <Icon src={guild.icon_url} name={guild.name} className="fosscord-federation-guild-icon" />
                <div className="fosscord-federation-title-row">
                    <Text variant="heading-md/semibold" color="text-strong" tag="h3" className="fosscord-federation-title" id={titleId}>
                        <button type="button" className="fosscord-federation-card-button" title={guild.name} aria-haspopup="dialog" onClick={() => openPreview(guild)}>
                            <Highlight text={guild.name} words={words} />
                        </button>
                    </Text>
                    {guild.verified && <VerifiedMark />}
                </div>
                {guild.description && (
                    <Text variant="text-sm/normal" color="text-default" className="fosscord-federation-description">
                        <Highlight text={guild.description} words={words} />
                    </Text>
                )}
                <Counts guild={guild} />
                <span className="fosscord-federation-instance-tag" title={`Hosted on ${guild.instance_name} (${guild.instance})`}>
                    <Icon src={guild.instance_icon_url} name={guild.instance_name} className="fosscord-federation-instance-tag-icon" letters={1} />
                    <span className="fosscord-federation-ellipsis">{guild.instance_name}</span>
                </span>
            </div>
        </article>
    );
}

const REGISTRATION_NOTE: Record<Registration, string> = {
    open: "Anyone can sign up there.",
    invite: "Signing up there needs an invite.",
    approval: "Signups there need approval.",
    closed: "It isn't taking signups.",
};

const DAY = 86_400_000;
const month = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

function activity(activeAt: string | null | undefined) {
    const time = activeAt ? Date.parse(activeAt) : Number.NaN;
    if (Number.isNaN(time)) return null;
    const days = Math.floor((Date.now() - time) / DAY);
    if (days < 1) return "Active today";
    if (days < 2) return "Active yesterday";
    if (days < 30) return `Active ${days} days ago`;
    return null;
}

function GuildPreview({ guild: initial, onClose, transitionState }: { guild: RemoteGuild } & RenderModalProps) {
    const [guild, setGuild] = useState<GuildDetails>(initial);
    const [details, setDetails] = useState<"loading" | "loaded" | "failed">("loading");
    const [joining, setJoining] = useState(false);
    const [joinedId, setJoinedId] = useState<string | null>(initial.joined_guild_id ?? null);
    const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);
    const joined = !!joinedId && hasGuild(joinedId);

    useEffect(() => {
        let active = true;
        RestAPI.get({ url: `/federation/discovery/guilds/${encodeURIComponent(initial.id)}` })
            .then((res: { body: GuildDetails }) => {
                if (!active) return;
                setGuild((current) => ({ ...current, ...res.body }));
                if (res.body.joined_guild_id) setJoinedId(res.body.joined_guild_id);
                setDetails("loaded");
            })
            .catch(() => active && setDetails("failed"));
        return () => {
            active = false;
        };
    }, [initial.id]);

    const join = async () => {
        const code = inviteCode(guild.invite_url);
        if (!code) return setNotice({ text: "This server's invite link is broken. Open it on its instance instead.", failed: true });
        setJoining(true);
        setNotice(null);
        const result = await joinRemote({
            post: (timeout) => {
                const request = { url: inviteEndpoint(remoteKey(guild.instance, code)), body: {}, timeout };
                return RestAPI.post(request);
            },
            hasGuild,
            receiveGuild,
            navigate: (guildId, channelId) => {
                setJoinedId(guildId);
                rememberGuild(guildId, guild.instance.toLowerCase());
                onClose();
                NavigationRouter.transitionTo(`/channels/${guildId}${channelId ? `/${channelId}` : ""}`);
            },
        });
        setJoining(false);
        if (result.kind !== "opened") setNotice({ text: result.message, failed: result.kind !== "pending" });
    };

    const open = () => {
        onClose();
        NavigationRouter.transitionTo(`/channels/${joinedId}`);
    };

    const created = guild.created_at ? Date.parse(guild.created_at) : Number.NaN;
    const facts = [activity(guild.active_at), Number.isNaN(created) ? null : `Created ${month.format(created)}`].filter(Boolean);
    const welcome = guild.welcome;

    return (
        <Modal
            transitionState={transitionState}
            onClose={onClose}
            size="md"
            title={
                <span className="fosscord-federation-preview-title">
                    <span className="fosscord-federation-ellipsis">{guild.name}</span>
                    {guild.verified && <VerifiedMark />}
                </span>
            }
            subtitle={`On ${guild.instance_name}`}
            notice={notice?.failed ? { message: notice.text, type: "critical" } : undefined}
            actions={[
                joined
                    ? { text: "Open server", variant: "primary", onClick: open }
                    : { text: joining ? "Joining…" : "Join server", variant: "primary", loading: joining, disabled: joining, onClick: join },
            ]}
        >
            <div className="fosscord-federation-preview">
                <div className="fosscord-federation-preview-hero">
                    <Banner guild={guild} className="fosscord-federation-preview-banner" />
                    <Icon src={guild.icon_url} name={guild.name} className="fosscord-federation-preview-icon" />
                </div>
                <div className="fosscord-federation-preview-facts">
                    <Counts guild={guild} />
                    {facts.length > 0 && (
                        <Text variant="text-xs/normal" color="text-muted">
                            {facts.join(" · ")}
                        </Text>
                    )}
                </div>
                {joined && (
                    <Text variant="text-sm/medium" color="text-default" className="fosscord-federation-preview-joined">
                        <CheckIcon />
                        You're already a member of this server.
                    </Text>
                )}
                {notice && !notice.failed && (
                    <Text variant="text-sm/normal" color="text-default" role="status">
                        {notice.text}
                    </Text>
                )}
                {guild.description ? (
                    <Text variant="text-md/normal" color="text-default" className="fosscord-federation-preview-description">
                        {guild.description}
                    </Text>
                ) : (
                    <Text variant="text-sm/normal" color="text-muted">
                        This server has no description.
                    </Text>
                )}
                {welcome && (
                    <section className="fosscord-federation-preview-section" aria-labelledby="fosscord-federation-preview-welcome">
                        <Text variant="text-xs/semibold" color="text-muted" tag="h4" id="fosscord-federation-preview-welcome" className="fosscord-federation-overline">
                            Welcome screen
                        </Text>
                        {welcome.description && (
                            <Text variant="text-sm/normal" color="text-default">
                                {welcome.description}
                            </Text>
                        )}
                        {welcome.channels.length > 0 && (
                            <ul className="fosscord-federation-welcome">
                                {welcome.channels.map((channel, index) => (
                                    <li key={index} className="fosscord-federation-welcome-row">
                                        <span className="fosscord-federation-welcome-emoji" aria-hidden="true">
                                            {channel.emoji_url ? (
                                                <img className="fosscord-federation-welcome-emoji-image" src={channel.emoji_url} alt="" loading="lazy" />
                                            ) : (
                                                (channel.emoji_name ?? "#")
                                            )}
                                        </span>
                                        <span className="fosscord-federation-welcome-text">
                                            <Text variant="text-sm/semibold" color="text-strong" className="fosscord-federation-ellipsis">
                                                #{channel.name}
                                            </Text>
                                            {channel.description && (
                                                <Text variant="text-xs/normal" color="text-muted" className="fosscord-federation-ellipsis">
                                                    {channel.description}
                                                </Text>
                                            )}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                )}
                {guild.rules?.length ? (
                    <section className="fosscord-federation-preview-section" aria-labelledby="fosscord-federation-preview-rules">
                        <Text variant="text-xs/semibold" color="text-muted" tag="h4" id="fosscord-federation-preview-rules" className="fosscord-federation-overline">
                            Rules
                        </Text>
                        <ol className="fosscord-federation-rules">
                            {guild.rules.map((rule, index) => (
                                <li key={index} className="fosscord-federation-rule">
                                    <span className="fosscord-federation-rule-number fosscord-federation-number" aria-hidden="true">
                                        {index + 1}
                                    </span>
                                    <Text variant="text-sm/normal" color="text-default" className="fosscord-federation-rule-text">
                                        {rule}
                                    </Text>
                                </li>
                            ))}
                        </ol>
                    </section>
                ) : null}
                {details === "loading" && ((guild.has_welcome && !welcome) || (!!guild.rule_count && !guild.rules)) && (
                    <div className="fosscord-federation-loading fosscord-federation-preview-placeholder" aria-hidden="true" />
                )}
                <section className="fosscord-federation-preview-section fosscord-federation-preview-instance" aria-labelledby="fosscord-federation-preview-host">
                    <Text variant="text-xs/semibold" color="text-muted" tag="h4" id="fosscord-federation-preview-host" className="fosscord-federation-overline">
                        Hosted on
                    </Text>
                    <div className="fosscord-federation-preview-host">
                        <Icon src={guild.instance_icon_url} name={guild.instance_name} className="fosscord-federation-instance-icon" />
                        <div className="fosscord-federation-instance-text">
                            <Text variant="text-md/semibold" color="text-strong" className="fosscord-federation-ellipsis">
                                {guild.instance_name}
                            </Text>
                            <Text variant="text-xs/normal" color="text-muted" className="fosscord-federation-ellipsis">
                                {guild.instance}
                                {guild.instance_registration ? ` · ${REGISTRATION[guild.instance_registration]}` : ""}
                            </Text>
                        </div>
                    </div>
                    {guild.instance_description && (
                        <Text variant="text-sm/normal" color="text-default" className="fosscord-federation-lede">
                            {guild.instance_description}
                        </Text>
                    )}
                    <Text variant="text-sm/normal" color="text-muted" className="fosscord-federation-lede">
                        {`Joining adds this server to your list here on ${instanceName()}, with the account you're using now. You don't need an account on ${guild.instance_name}.`}
                    </Text>
                    <a className="fosscord-federation-open" href={guild.invite_url} target="_blank" rel="noopener noreferrer">
                        Open the invite on {guild.instance_name}
                    </a>
                </section>
                {details === "failed" && (
                    <Text variant="text-xs/normal" color="text-muted" role="status">
                        Couldn't load the welcome screen. The rest of this preview may be up to 5 minutes old.
                    </Text>
                )}
            </div>
        </Modal>
    );
}

function openPreview(guild: RemoteGuild) {
    openModal((props: RenderModalProps) => (
        <ErrorBoundary noop>
            <GuildPreview {...props} guild={guild} />
        </ErrorBoundary>
    ));
}

function SkeletonCards({ count, compact = false }: { count: number; compact?: boolean }) {
    return (
        <>
            {Array.from({ length: count }, (_, index) => (
                <div
                    key={index}
                    className={`fosscord-federation-card fosscord-federation-guild fosscord-federation-skeleton${compact ? " fosscord-federation-guild-compact" : ""}`}
                    aria-hidden="true"
                >
                    <span className="fosscord-federation-guild-banner fosscord-federation-skeleton-block" />
                    <span className="fosscord-federation-guild-body">
                        <span className="fosscord-federation-guild-icon fosscord-federation-skeleton-block" />
                        <span className="fosscord-federation-skeleton-line fosscord-federation-skeleton-block" />
                        <span className="fosscord-federation-skeleton-line fosscord-federation-skeleton-block" />
                        <span className="fosscord-federation-skeleton-line fosscord-federation-skeleton-short fosscord-federation-skeleton-block" />
                    </span>
                </div>
            ))}
        </>
    );
}

const PAGE_SIZE = 24;
const SEARCH_PAGE_SIZE = 12;
const SEARCH_STRIP_HEIGHT = 312;
const SEARCH_ERROR_HEIGHT = 96;
const SEARCH_DELAY = 250;

type Sort = "relevance" | "active" | "members" | "newest";
const SORTS: { value: Sort; label: string }[] = [
    { value: "relevance", label: "Recommended" },
    { value: "active", label: "Most active" },
    { value: "members", label: "Most members" },
    { value: "newest", label: "Newest" },
];

type DirectoryQuery = { query: string; categoryId: number | null; sort: Sort; instance: string | null };

const discoveryUrl = (params: DirectoryQuery & { offset: number; limit: number }) => {
    const search = new URLSearchParams({ offset: String(params.offset), limit: String(params.limit) });
    if (params.query) search.set("query", params.query);
    if (params.categoryId != null && params.categoryId >= 0) search.set("category_id", String(params.categoryId));
    if (params.sort !== "relevance") search.set("sort", params.sort);
    if (params.instance) search.set("instance", params.instance);
    return `/federation/discovery?${search}`;
};

type PageState = {
    status: "loading" | "loaded" | "failed";
    refreshing: boolean;
    directory: Directory | null;
    guilds: RemoteGuild[];
    total: number;
    more: "idle" | "loading" | "failed";
};

function useDirectoryPages(params: DirectoryQuery, pageSize: number, enabled = true) {
    const [state, setState] = useState<PageState>({ status: "loading", refreshing: false, directory: null, guilds: [], total: 0, more: "idle" });
    const [attempt, setAttempt] = useState(0);
    const generation = useRef(0);
    const { query, categoryId, sort, instance } = params;
    useEffect(() => {
        const current = ++generation.current;
        if (!enabled) return;
        setState((previous) =>
            previous.status === "loaded"
                ? { ...previous, refreshing: true, more: "idle" }
                : { status: "loading", refreshing: false, directory: null, guilds: [], total: 0, more: "idle" },
        );
        RestAPI.get({ url: discoveryUrl({ query, categoryId, sort, instance, offset: 0, limit: pageSize }) })
            .then((res: { body: Directory }) => {
                if (current !== generation.current) return;
                const body = res.body;
                setState({ status: "loaded", refreshing: false, directory: body, guilds: body.available ? body.guilds : [], total: body.available ? body.total : 0, more: "idle" });
            })
            .catch(() => current === generation.current && setState((previous) => ({ ...previous, status: "failed", refreshing: false })));
    }, [query, categoryId, sort, instance, pageSize, enabled, attempt]);

    const loadMore = () => {
        if (state.more === "loading" || state.refreshing || state.guilds.length >= state.total) return;
        const current = generation.current;
        setState((previous) => ({ ...previous, more: "loading" }));
        RestAPI.get({ url: discoveryUrl({ query, categoryId, sort, instance, offset: state.guilds.length, limit: pageSize }) })
            .then((res: { body: Directory }) => {
                if (current !== generation.current) return;
                const body = res.body;
                if (!body.available) return setState((previous) => ({ ...previous, more: "idle" }));
                setState((previous) => {
                    const seen = new Set(previous.guilds.map((guild) => guild.id));
                    return { ...previous, guilds: [...previous.guilds, ...body.guilds.filter((guild) => !seen.has(guild.id))], total: body.total, more: "idle" };
                });
            })
            .catch(() => current === generation.current && setState((previous) => ({ ...previous, more: "failed" })));
    };

    return { ...state, loadMore, retry: () => setAttempt((value) => value + 1) };
}

function RemoteSearchResults({ query, pages }: { query: string; pages: ReturnType<typeof useDirectoryPages> }) {
    const words = useMemo(() => searchWords(query), [query]);
    if (pages.status === "failed")
        return (
            <section className="fosscord-federation-search fosscord-federation-search-error" style={{ height: SEARCH_ERROR_HEIGHT }} aria-label="Servers on other instances">
                <Text variant="text-sm/normal" color="text-muted" role="status">
                    Couldn't search other instances.
                </Text>
                <Button size="small" variant="secondary" onClick={pages.retry}>
                    Try again
                </Button>
            </section>
        );
    if (pages.status !== "loaded" || !pages.guilds.length) return null;
    return (
        <section className="fosscord-federation-search" style={{ height: SEARCH_STRIP_HEIGHT }} aria-labelledby="fosscord-federation-search-title">
            <div className="fosscord-federation-search-head">
                <GlobeIcon />
                <Text variant="heading-md/semibold" color="text-strong" tag="h3" id="fosscord-federation-search-title">
                    On other instances
                </Text>
                <Text variant="text-sm/normal" color="text-muted" className="fosscord-federation-number">
                    {`${number.format(pages.total)} ${pages.total === 1 ? "server matches" : "servers match"} "${query}"`}
                </Text>
            </div>
            <div className="fosscord-federation-search-row" aria-busy={pages.refreshing || pages.more === "loading"}>
                {pages.guilds.map((guild) => (
                    <GuildCard key={guild.id} guild={guild} words={words} compact />
                ))}
                {pages.guilds.length < pages.total && (
                    <div className="fosscord-federation-search-more">
                        <Button size="small" variant="secondary" onClick={pages.loadMore} disabled={pages.more === "loading"}>
                            {pages.more === "loading" ? "Loading…" : pages.more === "failed" ? "Try again" : "Show more"}
                        </Button>
                    </div>
                )}
            </div>
        </section>
    );
}

function useRemoteSearch(query: string | null | undefined, categoryId: number | null | undefined) {
    const text = (query ?? "").trim();
    const pages = useDirectoryPages({ query: text, categoryId: categoryId ?? null, sort: "relevance", instance: null }, SEARCH_PAGE_SIZE, !!text);
    const visible = !!text && pages.status === "loaded" && pages.guilds.length > 0;
    const height = !text ? 0 : pages.status === "failed" ? SEARCH_ERROR_HEIGHT : visible ? SEARCH_STRIP_HEIGHT : 0;
    return { height, element: text ? <RemoteSearchResults key="fosscord-federation-search" query={text} pages={pages} /> : null };
}

function GlobeIcon() {
    return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
        </svg>
    );
}

function openOtherInstances() {
    ServersQueryStore.resetState();
    ServersTabStore.resetState();
    GlobalDiscovery.transitionToGlobalDiscovery({ tab: SERVERS, selectedServersTab: TAB });
}

function useSidebarTab(tab: string, selectedTab: string | null) {
    const serversTab = ServersTabStore.useField("selectedTab");
    const onOtherInstances = selectedTab === SERVERS && serversTab === TAB;
    if (tab === TAB) return { selected: onOtherInstances, onClick: () => openOtherInstances };
    const leaving = tab === SERVERS && onOtherInstances;
    return {
        selected: selectedTab === tab && !leaving,
        onClick: (original: () => void) =>
            leaving
                ? () => {
                      ServersTabStore.setState({ selectedTab: null });
                      original();
                  }
                : original,
    };
}

function InstanceTag({ instance }: { instance: string }) {
    return (
        <span className="fosscord-federation-user-tag" title={`From ${nameOf(instance)}, another instance`}>
            {instance}
        </span>
    );
}

type RemoteBadge = { id: string; kind: "pride" | "staff" | "badge"; description: string; label: string | null; icon_url: string | null };
type RemoteBadges = { instance: string | null; badges: RemoteBadge[] };
const REMOTE_BADGE_TTL = 60_000;
const remoteBadgeCache = new Map<string, { at: number; value: Promise<RemoteBadges> }>();

function loadRemoteBadges(userId: string) {
    const cached = remoteBadgeCache.get(userId);
    if (cached && Date.now() - cached.at < REMOTE_BADGE_TTL) return cached.value;
    const value = RestAPI.get({ url: `/users/${userId}/remote-badges` }).then(
        ({ body }: { body: RemoteBadges }) => ({ instance: typeof body?.instance === "string" ? body.instance : null, badges: Array.isArray(body?.badges) ? body.badges : [] }),
        () => ({ instance: null, badges: [] }),
    );
    if (remoteBadgeCache.size > 500) remoteBadgeCache.clear();
    remoteBadgeCache.set(userId, { at: Date.now(), value });
    return value;
}

function ForeignStaffIcon() {
    return (
        <svg
            className="fosscord-remote-badge-staff-icon"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M11 20.9A9 9 0 1 1 20.9 11" />
            <path d="M3 12h8M12 3c2 2.1 3.2 4.6 3.6 7.4M12 3c-2.5 2.6-3.8 5.6-3.8 9 0 2.9 1 5.6 2.8 8" />
            <path d="M18 14l4 1.5v2.7c0 2.2-1.6 3.6-4 4.8-2.4-1.2-4-2.6-4-4.8v-2.7l4-1.5Z" />
        </svg>
    );
}

const RemoteBadgeGroup = ErrorBoundary.wrap(
    function RemoteBadgeGroup({ userId }: { userId: string }) {
        const instance = userInstance(UserStore.getUser(userId));
        const [data, setData] = useState<RemoteBadges | null>(null);
        useEffect(() => {
            if (!instance) return;
            let live = true;
            loadRemoteBadges(userId).then((value) => live && setData(value));
            return () => {
                live = false;
            };
        }, [userId, instance]);
        if (!instance || !data?.badges.length || data.instance !== instance) return null;
        return (
            <div className="fosscord-remote-badges" role="group" aria-label={`Badges from ${instance}, another instance`}>
                <span className="fosscord-remote-badges-label">
                    <GlobeIcon />
                    On {instance}
                </span>
                {data.badges.map((badge) => (
                    <Tooltip key={badge.id} text={badge.description}>
                        {(props) =>
                            badge.kind === "staff" || !badge.icon_url ? (
                                <span {...props} className="fosscord-remote-badge-staff" role="img" aria-label={badge.description}>
                                    <ForeignStaffIcon />
                                    {badge.label ?? `Staff on ${instance}`}
                                </span>
                            ) : (
                                <img {...props} className="fosscord-remote-badge" src={badge.icon_url} alt={badge.description} loading="lazy" />
                            )
                        }
                    </Tooltip>
                ))}
            </div>
        );
    },
    { noop: true },
);

const GLOBE_BADGE = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#9aa3b5" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/></svg>',
)}`;

const copyHandle: NavContextMenuPatchCallback = (children, props?: { user?: { username?: string; bot?: boolean } }) => {
    const user = props?.user;
    const handle = globalHandle(user);
    const link = friendLink(user);
    if (!handle || !link || user?.bot) return;
    children.push(
        <Menu.MenuGroup key="fosscord-federation-handle">
            <Menu.MenuItem
                id="fosscord-federation-copy-handle"
                label="Copy global username"
                subtext={handle}
                action={() => copyWithToast(handle, "Global username copied. People on any instance can paste it into Add Friend.")}
            />
            <Menu.MenuItem id="fosscord-federation-copy-friend-link" label="Copy friend link" action={() => copyWithToast(link, "Friend link copied.")} />
        </Menu.MenuGroup>,
    );
};

const sendFriendRequest = async (value: string) => {
    if (isHandle(value)) return addRemoteFriend(value);
    try {
        await RestAPI.post({ url: "/users/@me/relationships", body: { username: value, discriminator: null } });
    } catch (error) {
        throw errorText(error) ?? `The friend request to ${value} couldn't be sent. Try again.`;
    }
    return `Friend request sent to ${value}.`;
};

const openAddLink = () => {
    const params = new URLSearchParams(location.search);
    const raw = params.get("add");
    if (!raw) return;
    params.delete("add");
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
    const target = friendInput(raw);
    const own = UserStore.getCurrentUser();
    if (!target || own?.username === target) return;
    Alerts.show({
        title: "Send a friend request?",
        body: `Send a friend request to ${target}?`,
        confirmText: "Send friend request",
        cancelText: "Cancel",
        onConfirm: () =>
            sendFriendRequest(target).then(
                (message) => showToast(message, "success"),
                (message) => showToast(String(message), "failure"),
            ),
    });
};

const hostedOn: NavContextMenuPatchCallback = (children, props?: { guild?: { id?: string } }) => {
    const instance = guildInstance(props?.guild);
    if (!instance) return;
    children.unshift(
        <Menu.MenuGroup key="fosscord-federation-host">
            <Menu.MenuItem
                id="fosscord-federation-host"
                label={`Hosted on ${nameOf(instance)}`}
                subtext={nameOf(instance) === instance ? undefined : instance}
                action={() => {}}
                disabled
            />
        </Menu.MenuGroup>,
    );
};

function InstanceCard({ instance, onSelect }: { instance: RemoteInstance; onSelect(id: string): void }) {
    const count = instance.guild_count ?? 0;
    return (
        <article className="fosscord-federation-card fosscord-federation-instance" aria-labelledby={`fosscord-federation-instance-${instance.id}`}>
            <Icon src={instance.icon_url} name={instance.name} className="fosscord-federation-instance-icon" />
            <div className="fosscord-federation-instance-text">
                <Text variant="text-md/semibold" color="text-strong" tag="h4" className="fosscord-federation-ellipsis" id={`fosscord-federation-instance-${instance.id}`}>
                    <button type="button" className="fosscord-federation-card-button" onClick={() => onSelect(instance.id)}>
                        {instance.name}
                    </button>
                </Text>
                <Text variant="text-xs/normal" color="text-muted" className="fosscord-federation-ellipsis fosscord-federation-number">
                    {`${instance.id} · ${REGISTRATION[instance.registration]} · ${number.format(count)} ${count === 1 ? "server" : "servers"}`}
                </Text>
                {instance.description && (
                    <Text variant="text-sm/normal" color="text-default" className="fosscord-federation-description">
                        {instance.description}
                    </Text>
                )}
            </div>
        </article>
    );
}

function InstanceHeader({ instance, onClear }: { instance: RemoteInstance; onClear(): void }) {
    return (
        <section className="fosscord-federation-instance-header" aria-labelledby="fosscord-federation-instance-title">
            <Icon src={instance.icon_url} name={instance.name} className="fosscord-federation-instance-header-icon" />
            <div className="fosscord-federation-instance-text">
                <Text variant="heading-lg/semibold" color="text-strong" tag="h3" id="fosscord-federation-instance-title" className="fosscord-federation-ellipsis">
                    {instance.name}
                </Text>
                <Text variant="text-xs/normal" color="text-muted" className="fosscord-federation-ellipsis">
                    {instance.id}
                </Text>
                {instance.description && (
                    <Text variant="text-sm/normal" color="text-default" className="fosscord-federation-lede">
                        {instance.description}
                    </Text>
                )}
                <Text variant="text-sm/normal" color="text-muted" className="fosscord-federation-lede">
                    {`${REGISTRATION_NOTE[instance.registration]} You can join its servers from here without an account there.`}
                </Text>
                <div className="fosscord-federation-instance-actions">
                    <a className="fosscord-federation-open" href={instance.url} target="_blank" rel="noopener noreferrer">
                        Visit {instance.name}
                    </a>
                    <button type="button" className="fosscord-federation-text-button" onClick={onClear}>
                        Show all instances
                    </button>
                </div>
            </div>
        </section>
    );
}

type EmptyAction = { label: string; onClick(): void };

function EmptyState({ title, body, actions = [] }: { title: string; body: string; actions?: EmptyAction[] }) {
    return (
        <div className="fosscord-federation-empty" role="status">
            <Text variant="heading-md/semibold" color="text-strong">
                {title}
            </Text>
            <Text variant="text-sm/normal" color="text-muted" className="fosscord-federation-lede">
                {body}
            </Text>
            {actions.length > 0 && (
                <div className="fosscord-federation-empty-action">
                    {actions.map((action) => (
                        <Button key={action.label} size="small" variant="secondary" onClick={action.onClick}>
                            {action.label}
                        </Button>
                    ))}
                </div>
            )}
        </div>
    );
}

function SearchIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
        </svg>
    );
}

function ClearIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
        </svg>
    );
}

function useDebounced(value: string, delay: number) {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        if (!value.trim()) return setDebounced(value);
        const timer = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);
    return [debounced, setDebounced] as const;
}

function OtherInstances({ onScroll }: { onScroll?: (event: UIEvent<HTMLDivElement>) => void }) {
    const [input, setInput] = useState("");
    const [debounced, setDebounced] = useDebounced(input, SEARCH_DELAY);
    const [sort, setSort] = useState<Sort>("relevance");
    const [instance, setInstance] = useState<string | null>(null);
    const query = debounced.trim();
    const pages = useDirectoryPages({ query, categoryId: null, sort, instance }, PAGE_SIZE);
    const directory = pages.directory;
    const words = useMemo(() => searchWords(query), [query]);
    const page = useRef<HTMLDivElement>(null);
    const sentinel = useRef<HTMLDivElement>(null);
    const searchInput = useRef<HTMLInputElement>(null);
    const loadMore = useRef(pages.loadMore);
    loadMore.current = pages.loadMore;
    const hasMore = pages.status === "loaded" && pages.guilds.length < pages.total && pages.more === "idle" && !pages.refreshing;

    useEffect(() => {
        if (!hasMore || !sentinel.current || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && loadMore.current(), {
            root: page.current,
            rootMargin: "0px 0px 800px 0px",
        });
        observer.observe(sentinel.current);
        return () => observer.disconnect();
    }, [hasMore, pages.guilds.length]);

    const instances = directory?.available ? directory.instances : [];
    const selected = instance ? instances.find((entry) => entry.id === instance) : undefined;
    const matchCounts = directory?.available ? directory.match_counts : null;
    const countOf = (entry: RemoteInstance) => (matchCounts ? (matchCounts[entry.id] ?? 0) : (entry.guild_count ?? 0));
    const allCount = instances.reduce((sum, entry) => sum + countOf(entry), 0);
    const [showEmpty, setShowEmpty] = useState(false);
    const ranked = [...instances].sort((a, b) => countOf(b) - countOf(a) || a.name.localeCompare(b.name));
    const chips = showEmpty ? ranked : ranked.filter((entry) => countOf(entry) > 0 || entry.id === instance);
    const hiddenChips = ranked.length - chips.length;

    const selectInstance = (id: string | null) => {
        setInstance(id);
        page.current?.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    };
    const clearSearch = () => {
        setInput("");
        setDebounced("");
        searchInput.current?.focus();
    };

    const resultLabel = query
        ? `${number.format(pages.total)} ${pages.total === 1 ? "server matches" : "servers match"} "${query}"`
        : `${number.format(pages.total)} ${pages.total === 1 ? "server" : "servers"}`;

    return (
        <div className="fosscord-federation-page" onScroll={onScroll} ref={page}>
            <header className="fosscord-federation-hero">
                <Text variant="heading-xl/semibold" color="text-strong" tag="h2">
                    Other instances
                </Text>
                <Text variant="text-md/normal" color="text-default" className="fosscord-federation-lede">
                    {`Servers on other approved instances. Joining one adds it to your server list here on ${instanceName()}, with this account.`}
                </Text>
            </header>
            {pages.status === "failed" && !directory ? (
                <EmptyState
                    title="Couldn't load other instances"
                    body="Your connection to this instance dropped or it didn't answer. Nothing changed on your account."
                    actions={[{ label: "Try again", onClick: pages.retry }]}
                />
            ) : directory && !directory.available ? (
                <EmptyState
                    title={directory.reason === "disabled" ? "This instance doesn't connect to other instances" : "Other instances aren't available right now"}
                    body={
                        directory.reason === "disabled"
                            ? "Its admins turned federation off, so servers from other instances can't be listed or joined from here."
                            : "This instance hasn't got a current list from the federation registry yet. It checks again every 5 minutes, so try again later."
                    }
                />
            ) : (
                <>
                    <div className="fosscord-federation-toolbar" role="search" aria-label="Servers on other instances">
                        <label className="fosscord-federation-search-field">
                            <SearchIcon />
                            <span className="fosscord-federation-visually-hidden">Search servers on other instances</span>
                            <input
                                ref={searchInput}
                                type="search"
                                enterKeyHint="search"
                                autoComplete="off"
                                spellCheck={false}
                                maxLength={100}
                                placeholder="Search servers"
                                value={input}
                                onChange={(event) => setInput(event.currentTarget.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") setDebounced(input);
                                    if (event.key === "Escape" && input) {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        clearSearch();
                                    }
                                }}
                            />
                            {input && (
                                <button type="button" className="fosscord-federation-clear" aria-label="Clear search" onClick={clearSearch}>
                                    <ClearIcon />
                                </button>
                            )}
                        </label>
                        <label className="fosscord-federation-sort">
                            <Text variant="text-sm/medium" color="text-muted" tag="span">
                                Sort by
                            </Text>
                            <span className="fosscord-federation-select">
                                <select value={sort} onChange={(event) => setSort(event.currentTarget.value as Sort)}>
                                    {SORTS.map((option) => (
                                        <option key={option.value} value={option.value}>
                                            {option.label}
                                        </option>
                                    ))}
                                </select>
                                <svg
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true"
                                >
                                    <path d="m6 9 6 6 6-6" />
                                </svg>
                            </span>
                        </label>
                    </div>
                    {instances.length > 1 && (
                        <div className="fosscord-federation-chips" role="group" aria-label="Filter by instance">
                            <button type="button" className="fosscord-federation-chip" aria-pressed={!instance} onClick={() => selectInstance(null)}>
                                All instances
                                <span className="fosscord-federation-chip-count fosscord-federation-number">{number.format(allCount)}</span>
                            </button>
                            {chips.map((entry) => (
                                <button
                                    key={entry.id}
                                    type="button"
                                    className="fosscord-federation-chip"
                                    aria-pressed={instance === entry.id}
                                    title={entry.id}
                                    onClick={() => selectInstance(instance === entry.id ? null : entry.id)}
                                >
                                    <Icon src={entry.icon_url} name={entry.name} className="fosscord-federation-chip-icon" letters={1} />
                                    <span className="fosscord-federation-ellipsis">{entry.name}</span>
                                    <span className="fosscord-federation-chip-count fosscord-federation-number">{number.format(countOf(entry))}</span>
                                </button>
                            ))}
                            {(hiddenChips > 0 || showEmpty) && (
                                <button type="button" className="fosscord-federation-chip" aria-expanded={showEmpty} onClick={() => setShowEmpty(!showEmpty)}>
                                    {showEmpty
                                        ? `Hide instances without ${matchCounts ? "matches" : "servers"}`
                                        : `Show ${number.format(hiddenChips)} without ${matchCounts ? "matches" : "servers"}`}
                                </button>
                            )}
                        </div>
                    )}
                    {selected && <InstanceHeader instance={selected} onClear={() => selectInstance(null)} />}
                    <section className="fosscord-federation-section" aria-labelledby="fosscord-federation-servers" aria-busy={pages.status === "loading" || pages.refreshing}>
                        <div className="fosscord-federation-section-head">
                            <Text variant="heading-lg/semibold" color="text-strong" tag="h3" id="fosscord-federation-servers">
                                {selected ? `Servers on ${selected.name}` : "Servers"}
                            </Text>
                            <Text variant="text-sm/normal" color="text-muted" className="fosscord-federation-number" role="status">
                                {pages.status === "loaded" && pages.total > 0 ? resultLabel : ""}
                            </Text>
                        </div>
                        {pages.status === "loading" ? (
                            <div className="fosscord-federation-grid">
                                <SkeletonCards count={8} />
                            </div>
                        ) : pages.guilds.length ? (
                            <>
                                <div className="fosscord-federation-grid" data-refreshing={pages.refreshing}>
                                    {pages.guilds.map((guild) => (
                                        <GuildCard key={guild.id} guild={guild} words={words} />
                                    ))}
                                    {pages.more === "loading" && <SkeletonCards count={Math.min(4, pages.total - pages.guilds.length)} />}
                                </div>
                                <div ref={sentinel} className="fosscord-federation-sentinel" aria-hidden="true" />
                                {pages.more === "failed" && (
                                    <div className="fosscord-federation-more">
                                        <Text variant="text-sm/normal" color="text-feedback-critical" role="alert">
                                            Couldn't load more servers.
                                        </Text>
                                        <Button size="small" variant="secondary" onClick={pages.loadMore}>
                                            Try again
                                        </Button>
                                    </div>
                                )}
                                {pages.status === "failed" && (
                                    <div className="fosscord-federation-more">
                                        <Text variant="text-sm/normal" color="text-feedback-critical" role="alert">
                                            Couldn't update the list. It shows the last results.
                                        </Text>
                                        <Button size="small" variant="secondary" onClick={pages.retry}>
                                            Try again
                                        </Button>
                                    </div>
                                )}
                                {pages.guilds.length < pages.total && pages.more === "idle" && (
                                    <div className="fosscord-federation-more">
                                        <Button size="small" variant="secondary" onClick={pages.loadMore} disabled={pages.refreshing}>
                                            Show more servers
                                        </Button>
                                    </div>
                                )}
                            </>
                        ) : query ? (
                            <EmptyState
                                title={`No servers match "${query}"`}
                                body={
                                    selected
                                        ? `Nothing on ${selected.name} matches every word. Check the spelling, use fewer words or search all instances.`
                                        : "Every word has to match the start of a word in a server's name, description or keywords. Check the spelling or use fewer words."
                                }
                                actions={[
                                    { label: "Clear search", onClick: clearSearch },
                                    ...(selected ? [{ label: "Search all instances", onClick: () => selectInstance(null) }] : []),
                                ]}
                            />
                        ) : selected ? (
                            <EmptyState
                                title={`${selected.name} doesn't list any servers yet`}
                                body="Its servers show up here once their owners turn on Show on other instances and they get verified."
                                actions={[{ label: "Show all instances", onClick: () => selectInstance(null) }]}
                            />
                        ) : (
                            <EmptyState
                                title="No servers from other instances yet"
                                body={
                                    directory?.available && directory.verification === "instance"
                                        ? "Servers show up here once their owners turn on Show on other instances and this instance's admins verify them for you."
                                        : "Servers show up here once their owners turn on Show on other instances and their instance verifies them. The registry adds them within an hour."
                                }
                            />
                        )}
                    </section>
                    {directory?.available && (
                        <section className="fosscord-federation-section" aria-labelledby="fosscord-federation-instances">
                            <Text variant="heading-lg/semibold" color="text-strong" tag="h3" id="fosscord-federation-instances">
                                Instances
                            </Text>
                            {instances.length ? (
                                <div className="fosscord-federation-list">
                                    {instances.map((entry) => (
                                        <InstanceCard key={entry.id} instance={entry} onSelect={selectInstance} />
                                    ))}
                                </div>
                            ) : (
                                <EmptyState
                                    title="No other instances yet"
                                    body="Instances that the registry approves, or that this instance's admins add as peers, show up here with their address and whether they take signups."
                                />
                            )}
                        </section>
                    )}
                </>
            )}
        </div>
    );
}

function OwnerSettings() {
    const guildId = GuildSettingsStore.getGuildId();
    const [state, setState] = useState<OwnerState | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!guildId) return;
        RestAPI.get({ url: `/guilds/${guildId}/global-discovery` })
            .then((res: { body: OwnerState }) => setState(res.body))
            .catch((err: { body?: { message?: string } }) => setError(err?.body?.message ?? "Couldn't load this setting."));
    }, [guildId]);

    const change = async (enabled: boolean) => {
        if (!guildId) return;
        setSaving(true);
        setError(null);
        try {
            const res = await RestAPI.patch({ url: `/guilds/${guildId}/global-discovery`, body: { enabled } });
            setState(res.body);
            showToast(enabled ? "This server can now show on other instances" : "This server no longer shows on other instances", "success");
        } catch (err) {
            setError((err as { body?: { message?: string } })?.body?.message ?? "Couldn't save. Try again.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fosscord-federation-settings">
            <Text variant="heading-lg/semibold" color="text-strong" tag="h2">
                Other instances
            </Text>
            <Text variant="text-sm/normal" color="text-muted" className="fosscord-federation-lede">
                Let people on other approved instances find this server in their Discovery. They join through a permanent invite link, which is created for you if the server
                doesn't have one.
            </Text>
            {state && (
                <>
                    <FormSwitch
                        title="Show on other instances"
                        description="Lists this server's name, icon, description and member count on other instances after verification."
                        value={state.enabled}
                        disabled={saving || !state.federation_enabled}
                        onChange={change}
                    />
                    <div className="fosscord-federation-status" role="status">
                        <Text variant="text-sm/medium" color="text-default">
                            {!state.federation_enabled ? "This instance's admins turned federation off." : STATUS[state.status]}
                        </Text>
                        {state.enabled && state.invite_url && (
                            <div className="fosscord-federation-invite">
                                <Text variant="text-xs/normal" color="text-muted">
                                    Invite link people from other instances use
                                </Text>
                                <div className="fosscord-federation-invite-row">
                                    <span className="fosscord-federation-link">{state.invite_url}</span>
                                    <Button
                                        size="small"
                                        variant="secondary"
                                        onClick={() => navigator.clipboard.writeText(state.invite_url as string).then(() => showToast("Invite link copied", "success"))}
                                    >
                                        Copy link
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                </>
            )}
            {error && (
                <Text variant="text-sm/normal" color="text-feedback-critical" role="alert">
                    {error}
                </Text>
            )}
        </div>
    );
}

export default definePlugin({
    name: "FosscordFederation",
    description:
        "Adds Other instances to Discover with servers you can join from here, the Show on other instances switch for owners, invites and friend requests across instances, and tags for remote users and servers.",
    authors: [FosscordAuthor],
    required: true,
    dependencies: ["BadgeAPI"],
    managedStyle,

    inviteEndpoint,
    joinInviteKey,
    chatInviteKey,
    errorText,
    keepInviteKey,
    noteInviteError,
    remoteError,
    isHandle,
    addRemoteFriend,

    friendInput,

    start() {
        if (UserStore.getCurrentUser()) {
            loadInstances();
            loadGuildInstances(Object.keys(GuildStore.getGuilds()));
            openAddLink();
        }
    },

    flux: {
        CONNECTION_OPEN() {
            loadInstances();
            loadGuildInstances(Object.keys(GuildStore.getGuilds()));
            openAddLink();
        },
        INVITE_ACCEPT_SUCCESS({ invite }: { invite?: { guild_id?: string; meowcord_guild?: { id?: unknown } & Record<string, unknown> } }) {
            const guildId = invite?.guild_id;
            if (!guildId || !invite?.meowcord_guild) return;
            ensureGuild(guildId, invite.meowcord_guild, { hasGuild, receiveGuild }).then((loaded) => {
                if (!loaded) showToast(UNLOADED_MESSAGE, "failure");
            });
        },
        GUILD_CREATE({ guild }: { guild?: { id?: string; federated_instance?: string | null } }) {
            if (!guild?.id) return;
            if (guild.federated_instance) rememberGuild(guild.id, guild.federated_instance.toLowerCase());
            else queueGuild(guild.id);
        },
    },

    contextMenus: {
        "guild-context": hostedOn,
        "guild-header-popout": hostedOn,
        "user-context": copyHandle,
        "user-profile-actions": copyHandle,
        "user-profile-overflow-menu": copyHandle,
    },

    userProfileBadges: [
        {
            id: "fosscord-federation-instance",
            key: "fosscord-federation-instance",
            getBadges: ({ userId }: { userId: string }) => {
                const instance = userInstance(UserStore.getUser(userId));
                if (!instance) return [];
                return [
                    {
                        id: "fosscord-federation-instance",
                        key: "fosscord-federation-instance",
                        description: `From ${nameOf(instance)}, another instance. Badges marked "On ${instance}" were given there, not here`,
                        iconSrc: GLOBE_BADGE,
                    },
                ];
            },
        },
    ],

    renderRemoteBadges: (props: { displayProfile?: { userId?: string } }) => {
        const userId = props?.displayProfile?.userId;
        return userId ? <RemoteBadgeGroup key="fosscord-remote-badges" userId={userId} /> : null;
    },

    renderMessageDecoration: ({ message, author }: { message: { author?: { username?: string } }; author?: { nick?: string } }) => {
        const instance = userInstance(message.author);
        return instance && !author?.nick?.includes("@") ? <InstanceTag instance={instance} /> : null;
    },

    renderMemberListDecorator: ({ user }: { user?: { username?: string; globalName?: string | null } }) => {
        const instance = userInstance(user);
        return instance && user?.globalName ? <InstanceTag instance={instance} /> : null;
    },

    daveSession<T extends object>(session: T): T {
        const voice = (window as Window & { FosscordFederatedVoice?: FederatedVoiceIds }).FosscordFederatedVoice;
        if (!voice) return session;
        const target = session as unknown as DaveSession;
        const ids = (userIds: string[]) => userIds.map((id) => voice.daveId(id));
        const roster = (value: unknown) =>
            value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([daveId, key]) => [voice.localId(daveId), key])) : value;
        const mapped: Partial<DaveSession> = {
            Init: (version, groupId, userId, key) => target.Init(version, voice.daveGroup(groupId), userId, key),
            ProcessProposals: (proposals, userIds) => target.ProcessProposals(proposals, ids(userIds)),
            ProcessWelcome: (welcome, userIds) => roster(target.ProcessWelcome(welcome, ids(userIds))),
            ProcessCommit: (commit) => {
                const result = target.ProcessCommit(commit) as { rosterUpdate?: unknown } | null | undefined;
                return result?.rosterUpdate ? { ...result, rosterUpdate: roster(result.rosterUpdate) } : result;
            },
            GetKeyRatchet: (userId) => target.GetKeyRatchet(voice.daveId(userId)),
            GetPairwiseFingerprint: (version, userId, ...rest) => target.GetPairwiseFingerprint(version, voice.daveId(userId), ...rest),
        };
        return new Proxy(session, {
            get(object, key) {
                if (key in mapped) return mapped[key as keyof DaveSession];
                const value = Reflect.get(object, key);
                return typeof value === "function" ? value.bind(object) : value;
            },
        });
    },

    tabs: () => [{ id: TAB, label: "Other instances" }],
    sidebarTab: TAB,
    useSidebarTab,
    sidebarLabel: (tab: string) => (tab === TAB ? "Other instances" : null),
    renderSidebarIcon: () => <GlobeIcon />,
    renderOtherInstances: (props: { onScroll?: (event: UIEvent<HTMLDivElement>) => void }) => <OtherInstances {...props} />,
    useRemoteSearch,
    settingsSection: (props: { isOwner?: boolean }) => ({
        section: SECTION,
        label: "Other instances",
        ariaLabel: "Other instances",
        element: OwnerSettings,
        predicate: () => !!props.isOwner,
    }),

    patches: [
        {
            find: 'location:"UserProfileBadgeListRows"',
            replacement: {
                match: /(?<=\.Fragment,\{children:)(\i\.map\(\(\i,\i\)=>\(0,\i\.jsx\)\(\i,\{badges:.{0,400}?containerRef:0===\i\?\i:void 0\},\i\)\))(?=\}\))/,
                replace: "[...$1,$self.renderRemoteBadges(arguments[0])]",
            },
        },
        {
            find: "[getGlobalDiscoveryServerTabTitle] Unsupported tab",
            replacement: {
                match: /case (\i)\.\i\.HUBS:return \1\.(\i);(?=default:)/,
                replace: `$&case"${TAB}":return $1.$2;`,
            },
        },
        {
            find: "[getSectionHeight] Failed for section",
            replacement: [
                {
                    match: /(\]\.map\((\i)=>\(\{id:\2,label:\(0,\i\.\i\)\(\2\)\}\)\))/,
                    replace: "$1.concat($self.tabs())",
                },
                {
                    match: /(case \i\.\i\.HUBS:return\(0,\i\.jsx\)\(\i,\{onScroll:(\i)\}\);?)(default:)/,
                    replace: `$1case"${TAB}":return $self.renderOtherInstances({onScroll:$2});$3`,
                },
                {
                    match: /(searchResultsQuery:(\i),loadMore:\i,searchCategoryId:(\i)\}=function[\s\S]{0,1500}?\}\(\{loadId:\i\}\),)/,
                    replace: "$1fosscordRemote=$self.useRemoteSearch($2,$3),",
                },
                {
                    match: /(case 0:return\(0,\i\.jsxs\)\("div",\{style:\{paddingLeft:\i\.left,width:\i\.width-16\},className:[^}]{0,80}\}\),children:\[)/,
                    replace: "$1fosscordRemote.element,",
                },
                {
                    match: /(\{\[\i\.\i\]:\i\}\)\},\i\)\}\},\[\i,\i,\i)\]/,
                    replace: "$1,fosscordRemote.height]",
                },
                {
                    match: /case 0:let (\i)=(\i)\?16:68;/,
                    replace: "case 0:let $1=($2?16:68)+fosscordRemote.height;",
                },
                {
                    match: /(\[getSectionHeight\] Failed for section: \$\{\i\}`\)\}\},\[\i,\i)\]/,
                    replace: "$1,fosscordRemote.height]",
                },
            ],
        },
        {
            find: ".DISCOVERY_QUEST_TAB_CLICKED,{",
            replacement: [
                {
                    match: /(case \i\.GlobalDiscoveryTab\.QUESTS:return\(0,\i\.jsx\)\(\i\.\i,\{color:"currentColor"\}\))(\}\}\)\(\i\),\[\i\]\))/,
                    replace: "$1;case $self.sidebarTab:return $self.renderSidebarIcon()$2",
                },
                {
                    match: /(\i\.useMemo\(\(\)=>)(\(0,\i\.\i\)\((\i)\),\[\3\]\),)(\i)=(\i)===\3(?=,\i=\i\.useCallback\(\(\)=>\{switch\(\3\)\{case \i\.GlobalDiscoveryTab\.)/,
                    replace: "$1$self.sidebarLabel($3)??$2fosscordTab=$self.useSidebarTab($3,$5),$4=fosscordTab.selected",
                },
                {
                    match: /(role:"tab","aria-selected":\i,tabIndex:\i\?0:-1,onClick:)(\i)/,
                    replace: "$1fosscordTab.onClick($2)",
                },
                {
                    match: /(?<=role:"tablist","aria-orientation":"vertical",children:)(\i(?:\.GLOBAL_DISCOVERY_TABS.{0,60}?)?\.map\((\i)=>\(0,(\i)\.jsx\)\((\i),\{tab:\2\},\2\)\))/,
                    replace: "[$1,(0,$3.jsx)($4,{tab:$self.sidebarTab},$self.sidebarTab)]",
                },
            ],
        },
        {
            find: "itemGapPx:20,maxLines:1",
            replacement: {
                match: /if\(null==(\i)\|\|(\i)\.current===\1\)return;/,
                replace: "if(null==$1||$2.current===$1&&0!==$1)return;",
            },
        },
        {
            find: ".GUILD_SETTINGS_DISCOVERY_LANDING_PAGE,label",
            replacement: {
                match: /(\i)\.push\((\i)\(\i\.\i\.DISCOVERY_LANDING_PAGE,(\i)\)\)/,
                replace: "$&,$1.push($self.settingsSection($3))",
            },
        },
        {
            find: "INVITE_FRIEND_MEMBERS:",
            replacement: {
                match: /INVITE:(\i)=>`\/invites\/\$\{\1\}`/,
                replace: "INVITE:$1=>$self.inviteEndpoint($1)",
            },
        },
        {
            find: ".NetworkActionNames.INVITE_RESOLVE,properties",
            replacement: [
                {
                    match: /(let\{baseCode:(\i),[\s\S]{0,1500}?\.then\((\i)=>\{let (\i)=\3\.body;)/,
                    replace: "$1$4=$self.keepInviteKey($4,$2);",
                },
                {
                    match: /(let\{baseCode:(\i),[\s\S]{0,3000}?,(\i)=>\{)(let \i=null!=\3\.body&&\3\.body\.code===)/,
                    replace: "$1$self.noteInviteError($2,$3.body);$4",
                },
            ],
        },
        {
            find: "inviteHostRemainingPath:null",
            replacement: {
                match: /function (\i)\((\i),(\i)\)\{\i\.has\(\3\)\|\|\(\i\.add\(\3\),\i\.push\(\{type:\2,code:\3,url:(\i)\}\)\)\}/,
                replace: '$&{const fosscordInviteKey=$self.chatInviteKey($4);if(fosscordInviteKey){$1("INVITE",fosscordInviteKey);continue}}',
            },
        },
        {
            find: '"Join Guild",{inputValue:',
            all: true,
            replacement: {
                match: /let (\i)=(\i)\.split\("\/"\),(\i)=\1\[\1\.length-1\];/,
                replace: 'let $1=$2.split("/"),$3=$self.joinInviteKey($2);',
            },
        },
        {
            find: "hasJoinButton:!0",
            replacement: {
                match: /(resolveInvite\((\i),"Join Guild"[\s\S]{0,600}?)catch\((\i)\)\{(?="string"==typeof \3\?(\i)\(\3\))/,
                replace: "$1catch($3){if($self.remoteError($2,$3))return void $4($self.remoteError($2,$3));",
            },
        },
        {
            find: /\.startsWith\("@"\)&&\(\i=\i\.substring\(1\)\)/,
            replacement: {
                match: /(\i)=\1\.trim\(\)\)\.includes\("#"\)&&\1\.startsWith\("@"\)&&\(\1=\1\.substring\(1\)\);/,
                replace: "$&$1=$self.friendInput($1);if($self.isHandle($1))return $self.addRemoteFriend($1);",
            },
        },
        {
            find: "Refusing to create a decryptor for the local user ID",
            replacement: {
                match: /(this\.mlsSession=)(new \i\.Session\("","",\(\i,\i\)=>\{this\.emit\([^)]*\)\}\))/,
                replace: "$1$self.daveSession($2)",
            },
        },
    ],
});
