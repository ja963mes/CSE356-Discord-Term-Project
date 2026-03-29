import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Channel,
  Community,
  CommunityMember,
  Message,
  SearchResult,
  getCommunityChannels,
  getCommunityMembers,
  getMessages,
  getSampleChannels,
  getSampleMembers,
  listCommunities,
  search,
} from "../api/discord";
import { getMe, getDmUsers, logout, Me, DmUser } from "../api/auth";
import { Conversation, listConversations } from "../api/dms";
import { IncomingMessage, useWebSocket } from "../hooks/useWebSocket";
import { useActivityDetection } from "../hooks/useActivityDetection";
import { usePresence } from "../hooks/usePresence";
import UserPresence from "../components/UserPresence";
import ProfileSettingsModal from "../components/ProfileSettingsModal";
import DmList from "../components/DmList";
import DmChatView from "../components/DmChatView";
import CreateDmModal from "../components/CreateDmModal";
import {
  CreateCommunityModal,
  JoinCommunityPlaceholderModal,
  ServerActionMenuModal,
} from "../components/CommunityModals";

type CommunityModal = "none" | "menu" | "create" | "join";
type ViewMode = "channel" | "dm";

export default function ChatPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [dmUsers, setDmUsers] = useState<DmUser[]>([]);
  const [dmConversations, setDmConversations] = useState<Conversation[]>([]);
  const [selectedDmId, setSelectedDmId] = useState<string | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [selectedCommunityId, setSelectedCommunityId] = useState<string | null>(null);
  const [guildName, setGuildName] = useState("The Obsidian Architect");
  const [usingLiveCommunities, setUsingLiveCommunities] = useState(false);
  const [communityModal, setCommunityModal] = useState<CommunityModal>("none");
  const [showCreateDm, setShowCreateDm] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("channel");
  const [latestDmEvent, setLatestDmEvent] = useState<IncomingMessage | null>(null);

  const { handleMessage: handlePresenceMessage, getPresence } = usePresence();

  const handleMessage = useCallback((msg: IncomingMessage) => {
    console.log("[ws] incoming:", msg);
    handlePresenceMessage(msg);
    if (typeof msg.type === "string" && msg.type.startsWith("dm:")) {
      setLatestDmEvent(msg);
    }
  }, [handlePresenceMessage]);

  useEffect(() => {
    getMe().then((data) => {
      setMe(data);
    }).catch(() => setMe(null));
    getDmUsers().then(setDmUsers).catch(() => setDmUsers([]));
  }, []);

  const { send } = useWebSocket(handleMessage);
  useActivityDetection(send);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string>("general-chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<CommunityMember[]>([]);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  const refreshCommunities = useCallback(async (opts?: { preferSelectId?: string }) => {
    const list = await listCommunities();
    if (list === null) {
      setUsingLiveCommunities(false);
      setCommunities([]);
      setSelectedCommunityId(null);
      setGuildName("The Obsidian Architect");
      setChannels(getSampleChannels());
      setMembers(getSampleMembers());
      return;
    }
    setUsingLiveCommunities(true);
    setCommunities(list);
    const prefer = opts?.preferSelectId;
    if (prefer && list.some((c) => c.id === prefer)) {
      const c = list.find((x) => x.id === prefer)!;
      setSelectedCommunityId(c.id);
      setGuildName(c.name);
    } else if (list.length > 0) {
      setSelectedCommunityId(list[0].id);
      setGuildName(list[0].name);
    } else {
      setSelectedCommunityId(null);
      setGuildName("No community yet");
      setChannels([]);
      setMembers([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshCommunities();
      if (cancelled) return;
    })();
    return () => { cancelled = true; };
  }, [refreshCommunities]);

  useEffect(() => {
    if (!usingLiveCommunities || !selectedCommunityId) return;
    let cancelled = false;
    (async () => {
      const [chs, mems] = await Promise.all([
        getCommunityChannels(selectedCommunityId),
        getCommunityMembers(selectedCommunityId),
      ]);
      if (cancelled) return;
      if (chs?.length) {
        setChannels(chs);
        const firstText = chs.find((c) => c.type === "text") ?? chs[0];
        setSelectedChannelId((prev) => (chs.some((c) => c.id === prev) ? prev : firstText.id));
      } else {
        setChannels([]);
      }
      setMembers(mems ?? []);
    })();
    return () => { cancelled = true; };
  }, [usingLiveCommunities, selectedCommunityId]);

  useEffect(() => {
    getMessages(selectedChannelId)
      .then(setMessages)
      .catch(() => setMessages([]));
  }, [selectedChannelId]);

  const selectedChannel = useMemo(() => channels.find((c) => c.id === selectedChannelId), [channels, selectedChannelId]);
  const textChannels = useMemo(() => channels.filter((c) => c.type === "text"), [channels]);
  const selectedDm = useMemo(() => dmConversations.find((c) => c.conversationId === selectedDmId), [dmConversations, selectedDmId]);

  const dmDisplayNames = useMemo(() => {
    const map: Record<string, string> = {};
    if (me) {
      map[me.internal_id] = me.profile.displayName || me.username;
    }
    for (const u of dmUsers) {
      map[u.internal_id] = u.profile.displayName || u.username;
    }
    return map;
  }, [me, dmUsers]);

  useEffect(() => {
    if (!latestDmEvent || !me) return;
    const t = latestDmEvent.type;
    if (t === "dm:conversation:create") {
      const ids = latestDmEvent.participantIds as string[] | undefined;
      const conv = latestDmEvent.conversation as Conversation | undefined;
      if (!ids?.includes(me.internal_id) || !conv?.conversationId) return;
      setDmConversations((prev) => {
        if (prev.some((c) => c.conversationId === conv.conversationId)) return prev;
        return [conv, ...prev];
      });
      return;
    }
    if (t === "dm:participant:join") {
      const uid = latestDmEvent.userId as string | undefined;
      if (uid !== me.internal_id) return;
      listConversations().then(setDmConversations).catch(() => {});
    }
  }, [latestDmEvent, me]);

  async function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    try {
      const results = await search(searchQuery.trim());
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    }
  }

  function presenceDotClass(status: string) {
    switch (status) {
      case "online": return "bg-emerald-500";
      case "idle": return "bg-amber-400";
      case "away": return "bg-amber-400";
      default: return "bg-zinc-500";
    }
  }

  function presenceLabel(status: string) {
    switch (status) {
      case "online": return "Online";
      case "idle": return "Idle";
      case "away": return "Away";
      default: return "Offline";
    }
  }

  function roleLabel(role: string) {
    return role === "owner" ? "Owner" : role === "member" ? "Member" : role;
  }

  function closeCommunityModals() {
    setCommunityModal("none");
  }

  return (
    <div className="flex h-screen w-full">
      <ServerActionMenuModal
        open={communityModal === "menu"}
        onClose={closeCommunityModals}
        onCreate={() => setCommunityModal("create")}
        onJoin={() => setCommunityModal("join")}
      />
      <CreateCommunityModal
        open={communityModal === "create"}
        onBack={() => setCommunityModal("menu")}
        onClose={closeCommunityModals}
        onCreated={async (created) => {
          await refreshCommunities({ preferSelectId: created.id });
        }}
      />
      <JoinCommunityPlaceholderModal
        open={communityModal === "join"}
        onBack={() => setCommunityModal("menu")}
        onClose={closeCommunityModals}
      />
      <CreateDmModal
        open={showCreateDm}
        onClose={() => setShowCreateDm(false)}
        onCreated={(conversation) => {
          setDmConversations((prev) => [conversation, ...prev]);
          setSelectedDmId(conversation.conversationId);
          setViewMode("dm");
        }}
      />

      {/* LEFT PANEL: icon nav + channel list stacked, with shared profile bar at bottom */}
      <div className="flex flex-col flex-shrink-0 w-[336px]">
        <div className="flex flex-1 overflow-hidden">
          {/* COLUMN 1: SideNavBar */}
          <aside className="bg-[#111318] w-20 flex flex-col items-center py-4 gap-4 flex-shrink-0">
            {/* Brand / Home */}
            <div className="group relative flex items-center justify-center w-full">
              <div className="bg-[#5865F2] text-white rounded-2xl scale-110 w-12 h-12 flex items-center justify-center transition-all duration-300">
                <span className="material-symbols-outlined text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>
                  home
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-4 items-center w-full overflow-y-auto pb-4">
              {communities.map((c) => {
                const active = c.id === selectedCommunityId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    title={c.name}
                    onClick={() => {
                      setSelectedCommunityId(c.id);
                      setGuildName(c.name);
                    }}
                    className={
                      active
                        ? "flex items-center justify-center rounded-[2rem] bg-[#5865F2] text-white w-12 h-12 transition-all"
                        : "flex items-center justify-center rounded-[2rem] bg-[#171a1f] text-gray-400 w-12 h-12 hover:bg-[#5865F2] hover:text-white cursor-pointer transition-all"
                    }
                  >
                    <span className="text-sm font-bold">{c.name.slice(0, 2).toUpperCase()}</span>
                  </button>
                );
              })}
              <button
                type="button"
                title="Add a server"
                onClick={() => setCommunityModal("menu")}
                className="bg-[#171a1f] text-primary rounded-[2rem] hover:rounded-2xl transition-all duration-300 w-12 h-12 flex items-center justify-center hover:bg-primary-dim hover:text-on-primary cursor-pointer group-active:scale-95 border-0"
              >
                <span className="material-symbols-outlined text-2xl">add</span>
              </button>
            </div>
          </aside>

          {/* COLUMN 2: Channel List */}
          <section className="flex-1 bg-surface-container-low flex flex-col overflow-hidden">
            <div className="h-16 flex items-center px-4 font-headline font-bold text-lg text-on-surface flex-shrink-0">
              {guildName}
              <span className="material-symbols-outlined ml-auto text-on-surface-variant cursor-pointer">
                expand_more
              </span>
            </div>
            <div className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-1">
              <div className="flex items-center px-2 pt-4 pb-1 text-on-surface-variant uppercase text-[10px] font-bold tracking-widest">
                <span className="material-symbols-outlined text-[14px] mr-1">expand_more</span>
                Text Channels
              </div>
              {textChannels.map((c) => {
                const active = viewMode === "channel" && c.id === selectedChannelId;
                return (
                  <button
                    key={c.id}
                    className={
                      active
                        ? "flex items-center gap-2 px-2 py-2 rounded-lg bg-surface-container-highest text-on-surface font-semibold group transition-all"
                        : "flex items-center gap-2 px-2 py-2 rounded-lg text-on-surface-variant hover:bg-surface-variant/50 hover:text-on-surface group transition-all"
                    }
                    onClick={() => { setSelectedChannelId(c.id); setViewMode("channel"); setSelectedDmId(null); }}
                  >
                    <span className="material-symbols-outlined text-on-surface-variant group-hover:text-on-surface">tag</span>
                    {c.name}
                  </button>
                );
              })}

              <DmList
                selectedId={selectedDmId}
                onSelect={(c) => { setSelectedDmId(c.conversationId); setViewMode("dm"); }}
                onNewDm={() => setShowCreateDm(true)}
                conversations={dmConversations}
                setConversations={setDmConversations}
              />
            </div>
          </section>
        </div>

        {/* Profile bar spanning both columns */}
        <div className="p-2 bg-surface-container-lowest flex items-center gap-2">
          <div className="flex-1 overflow-hidden">
            <UserPresence
              userId={me?.internal_id ?? ""}
              displayName={me?.profile.displayName ?? "..."}
              avatarUrl={me?.profile.avatar ?? undefined}
              presence={getPresence(me?.internal_id ?? "")}
              size="sm"
            />
          </div>
          <div className="flex gap-1 text-on-surface-variant">
            <span className="material-symbols-outlined text-lg p-1 hover:bg-surface-container-high rounded transition-colors cursor-pointer">
              mic
            </span>
            <span
              className="material-symbols-outlined text-lg p-1 hover:bg-surface-container-high rounded transition-colors cursor-pointer"
              onClick={() => setShowSettings(true)}
            >
              settings
            </span>
            <span
              className="material-symbols-outlined text-lg p-1 hover:bg-surface-container-high rounded transition-colors cursor-pointer"
              title="Log out"
              onClick={() => logout().then(() => navigate("/login", { replace: true })).catch(() => navigate("/login", { replace: true }))}
            >
              logout
            </span>
          </div>
        </div>
      </div>

      {/* MAIN WRAPPER */}
      <main className="flex flex-1 h-screen overflow-hidden">
        {/* COLUMN 3: Main Chat Area — channel view or DM view */}
        {viewMode === "dm" && selectedDm && me ? (
          <DmChatView
            conversation={selectedDm}
            currentUserId={me.internal_id}
            displayNameByUserId={dmDisplayNames}
            wsEvent={latestDmEvent}
            onLeave={(id) => {
              setDmConversations((prev) => prev.filter((c) => c.conversationId !== id));
              setSelectedDmId(null);
              setViewMode("channel");
            }}
          />
        ) : (
        <section className="flex-1 bg-surface-container flex flex-col relative min-w-0">
          {/* TopNavBar */}
          <header className="h-16 flex items-center justify-between px-6 w-full bg-[#171a1f]/60 backdrop-blur-xl shadow-sm z-10">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-on-surface-variant">tag</span>
              <h1 className="text-[#f6f6fc] font-headline font-bold text-lg tracking-tight">
                {selectedChannel?.name ?? "general-chat"}
              </h1>
            </div>

            <div className="flex items-center gap-5">
              <nav className="hidden md:flex items-center gap-4 text-sm font-medium">
                <a className="text-[#9fa7ff] font-bold" href="#">Threads</a>
                <a className="text-gray-400 hover:text-[#f6f6fc] transition-colors" href="#">Pins</a>
              </nav>

              <div className="h-6 w-[1px] bg-outline-variant/20" />

              <div className="flex items-center gap-3 text-on-surface-variant">
                <span className="material-symbols-outlined hover:text-[#f6f6fc] cursor-pointer">notifications</span>
                <span className="material-symbols-outlined hover:text-[#f6f6fc] cursor-pointer">push_pin</span>
                <span className="material-symbols-outlined hover:text-[#f6f6fc] cursor-pointer">group</span>
              </div>

              <form className="relative ml-2" onSubmit={onSearchSubmit}>
                <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-sm">search</span>
                <input
                  className="bg-surface-container-lowest border-none text-xs rounded-lg pl-8 pr-4 py-1.5 w-36 focus:ring-1 focus:ring-primary focus:w-48 transition-all"
                  placeholder="Search"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </form>
            </div>
          </header>

          {/* Chat History */}
          <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-6 scroll-smooth">
            {messages.length === 0 ? (
              <div className="py-10 text-on-surface-variant">No messages yet.</div>
            ) : null}

            <div className="py-10">
              <p className="text-on-surface-variant text-sm">
                Welcome to the {selectedChannel?.name ?? "general-chat"} channel.
              </p>
            </div>

            {messages.map((m) => (
              <div key={m.id} className="flex gap-3 items-start">
                <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant text-xs">
                  {m.author.slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-bold text-on-surface">{m.author}</p>
                    <span className="text-[10px] text-on-surface-variant">
                      {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <p className="text-sm text-on-surface mt-1">{m.content}</p>
                </div>
              </div>
            ))}

            {searchResults.length > 0 ? (
              <div className="mt-4 p-3 rounded-lg bg-surface-container-highest">
                <p className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-2">
                  Search results
                </p>
                <div className="flex flex-col gap-2">
                  {searchResults.map((r) => (
                    <div key={r.id} className="text-sm text-on-surface">
                      <p className="font-semibold">{r.title}</p>
                      <p className="text-on-surface-variant">{r.snippet}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {/* Message Composer */}
          <div className="p-4 border-t border-outline-variant/20">
            <div className="flex items-center gap-3">
              <input
                className="flex-1 bg-surface-container-lowest border-none rounded-lg px-4 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:ring-1 focus:ring-primary"
                placeholder={`Message #${selectedChannel?.name ?? "general-chat"}`}
                onChange={() => {
                  // Placeholder composer
                }}
              />
              <button className="material-symbols-outlined text-on-surface-variant hover:text-on-surface cursor-pointer">
                send
              </button>
            </div>
          </div>
        </section>
        )}

        {/* COLUMN 4: Members + presence (only in channel view) */}
        {viewMode === "channel" && (
        <aside className="w-56 bg-surface-container-low border-l border-outline-variant/20 flex flex-col flex-shrink-0">
          <div className="h-16 flex items-center px-4 text-on-surface-variant uppercase text-[10px] font-bold tracking-widest">
            Members — {members.length}
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-4 flex flex-col gap-1">
            {members.length === 0 ? (
              <p className="px-2 text-xs text-on-surface-variant">No members to show.</p>
            ) : (
              members.map((m) => (
                <div
                  key={m.user_id}
                  className="px-2 py-1.5 rounded-md hover:bg-surface-variant/40"
                >
                  <div className="flex flex-col gap-0.5">
                    <UserPresence
                      userId={m.user_id}
                      displayName={m.display_name}
                      presence={getPresence(m.user_id)}
                      size="sm"
                    />
                    <p className="text-[10px] text-on-surface-variant truncate">{roleLabel(m.role)}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
        )}
      </main>

      {showSettings && me && (
        <ProfileSettingsModal
          me={me}
          presence={getPresence(me.internal_id)}
          onClose={() => setShowSettings(false)}
          onSend={send}
          onUpdated={(updated) => setMe((prev) => prev ? { ...prev, ...updated } : prev)}
        />
      )}
    </div>
  );
}
