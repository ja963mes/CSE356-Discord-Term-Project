import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  addChannelMember,
  Channel,
  ChannelAccessMember,
  Community,
  deleteChannel,
  getChannelMembers,
  getCommunityChannels,
  getCommunityMembers,
  getSampleChannels,
  getSampleMembers,
  joinChannel,
  leaveCommunity,
  listCommunities,
  removeChannelMember,
} from "../api/discord";
import { getMe, getDmUsers, logout, Me, DmUser } from "../api/auth";
import { listConversations } from "../api/dms";
import { IncomingMessage, useWebSocket } from "../hooks/useWebSocket";
import { useActivityDetection } from "../hooks/useActivityDetection";
import { usePresence } from "../hooks/usePresence";
import { useDmEvents } from "../hooks/useDmEvents";
import { useCommunityEvents } from "../hooks/useCommunityEvents";
import UserPresence from "../components/UserPresence";
import ProfileSettingsModal from "../components/ProfileSettingsModal";
import DmList from "../components/DmList";
import DmChatView from "../components/DmChatView";
import ChannelChatView from "../components/ChannelChatView";
import CreateDmModal from "../components/CreateDmModal";
import {
  CreateChannelModal,
  CreateCommunityModal,
  ManagePrivateChannelMembersModal,
  JoinCommunityPlaceholderModal,
  ServerActionMenuModal,
} from "../components/CommunityModals";

type CommunityModal = "none" | "menu" | "create" | "join";
type ViewMode = "channel" | "dm";
type ActivePanel = "home" | "server";

export default function ChatPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [dmUsers, setDmUsers] = useState<DmUser[]>([]);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [selectedCommunityId, setSelectedCommunityId] = useState<string | null>(null);
  const selectedCommunityIdRef = useRef<string | null>(null);
  useEffect(() => { selectedCommunityIdRef.current = selectedCommunityId; }, [selectedCommunityId]);
  const [guildName, setGuildName] = useState("The Obsidian Architect");
  const [usingLiveCommunities, setUsingLiveCommunities] = useState(false);
  const [communityModal, setCommunityModal] = useState<CommunityModal>("none");
  const [showCreateDm, setShowCreateDm] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("dm");
  const [activePanel, setActivePanel] = useState<ActivePanel>("home");

  const { handleMessage: handlePresenceMessage, getPresence } = usePresence();
  const {
    dmConversations, setDmConversations,
    selectedDmId, setSelectedDmId,
    latestDmEvent,
    handleDmMessage,
    onConversationCreated,
    onConversationLeft,
  } = useDmEvents(me);
  const { members, setMembers, channels, setChannels, handleCommunityMessage } = useCommunityEvents();

  const [latestChannelEvent, setLatestChannelEvent] = useState<IncomingMessage | null>(null);

  const handleMessage = useCallback((msg: IncomingMessage) => {
    console.log("[ws] incoming:", msg);
    handlePresenceMessage(msg);
    handleDmMessage(msg);
    handleCommunityMessage(msg, selectedCommunityIdRef.current);
    if (typeof msg.type === "string" && msg.type.startsWith("channel:")) {
      setLatestChannelEvent(msg);
    }
  }, [handlePresenceMessage, handleDmMessage, handleCommunityMessage]);

  useEffect(() => {
    getMe()
      .then((data) => {
        setMe(data);
        return Promise.all([
          getDmUsers().then(setDmUsers).catch((err) => { console.error("[ChatPage] getDmUsers failed:", err); setDmUsers([]); }),
          listConversations().then((convs) => {
            setDmConversations(convs);
            if (convs.length > 0) setSelectedDmId(convs[0].conversationId);
          }).catch((err) => { console.error("[ChatPage] listConversations failed:", err); setDmConversations([]); }),
        ]);
      })
      .catch(() => setMe(null));
  }, []);

  const { send } = useWebSocket(handleMessage);
  useActivityDetection(send);

  const [selectedChannelId, setSelectedChannelId] = useState<string>("general-chat");

  const [guildMenuOpen, setGuildMenuOpen] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showInviteMembers, setShowInviteMembers] = useState(false);
  const [selectedChannelMembers, setSelectedChannelMembers] = useState<ChannelAccessMember[]>([]);
  const [guildDataVersion, setGuildDataVersion] = useState(0);
  const guildMenuRef = useRef<HTMLDivElement>(null);

  const memberCommunityIds = useMemo(() => new Set(communities.map((c) => c.id)), [communities]);

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
  }, [usingLiveCommunities, selectedCommunityId, guildDataVersion]);

  const selectedChannel = useMemo(() => channels.find((c) => c.id === selectedChannelId), [channels, selectedChannelId]);

  const channelAccessible = useMemo(() => {
    if (!usingLiveCommunities) return true;
    if (!selectedChannel) return true;
    return selectedChannel.joined !== false;
  }, [usingLiveCommunities, selectedChannel]);


  const myGuildRole = useMemo(() => {
    if (!me || !usingLiveCommunities) return null;
    return members.find((m) => m.user_id === me.internal_id)?.role ?? null;
  }, [me, members, usingLiveCommunities]);

  const isGuildAdmin = myGuildRole === "owner" || myGuildRole === "admin";

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


  function roleLabel(role: string) {
    if (role === "owner") return "Owner";
    if (role === "admin") return "Admin";
    if (role === "member") return "Member";
    return role;
  }

  async function handleJoinChannel(channelId: string) {
    if (!selectedCommunityId) return;
    const r = await joinChannel(selectedCommunityId, channelId);
    if (r.ok) setGuildDataVersion((v) => v + 1);
  }

  async function handleDeleteChannel(channelId: string) {
    if (!selectedCommunityId || !isGuildAdmin) return;
    if (!window.confirm("Delete this channel? This cannot be undone.")) return;
    const r = await deleteChannel(selectedCommunityId, channelId);
    if (r.ok) {
      setGuildDataVersion((v) => v + 1);
      return;
    }
    window.alert(r.error);
  }

  async function handleInviteToPrivateChannel(userId: string): Promise<{ ok: boolean; message?: string }> {
    if (!selectedCommunityId || !selectedChannel?.is_private) return { ok: false, message: "No private channel selected." };
    const r = await addChannelMember(selectedCommunityId, selectedChannel.id, userId);
    if (!r.ok) return { ok: false, message: r.error };
    const refreshed = await getChannelMembers(selectedCommunityId, selectedChannel.id);
    if (refreshed) setSelectedChannelMembers(refreshed);
    setGuildDataVersion((v) => v + 1);
    return { ok: true, message: r.status === "already_member" ? "Already in channel" : "Added to channel" };
  }

  async function handleRemoveFromPrivateChannel(userId: string): Promise<{ ok: boolean; message?: string }> {
    if (!selectedCommunityId || !selectedChannel?.is_private) return { ok: false, message: "No private channel selected." };
    const r = await removeChannelMember(selectedCommunityId, selectedChannel.id, userId);
    if (!r.ok) return { ok: false, message: r.error };
    const refreshed = await getChannelMembers(selectedCommunityId, selectedChannel.id);
    if (refreshed) setSelectedChannelMembers(refreshed);
    setGuildDataVersion((v) => v + 1);
    return { ok: true, message: "Removed from channel" };
  }

  function closeCommunityModals() {
    setCommunityModal("none");
  }

  useEffect(() => {
    if (!guildMenuOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      if (guildMenuRef.current && !guildMenuRef.current.contains(e.target as Node)) {
        setGuildMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [guildMenuOpen]);

  async function handleLeaveCommunity() {
    if (!selectedCommunityId || !usingLiveCommunities || leaveBusy) return;
    setLeaveBusy(true);
    setLeaveError(null);
    try {
      const r = await leaveCommunity(selectedCommunityId);
      if (!r.ok) {
        setLeaveError(r.error);
        return;
      }
      setGuildMenuOpen(false);
      const list = await listCommunities();
      if (list === null || list.length === 0) {
        await refreshCommunities();
        return;
      }
      await refreshCommunities({ preferSelectId: list[0].id });
    } finally {
      setLeaveBusy(false);
    }
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
        memberCommunityIds={memberCommunityIds}
        onJoined={async (joined) => {
          await refreshCommunities({ preferSelectId: joined.id });
          closeCommunityModals();
        }}
      />
      <CreateDmModal
        open={showCreateDm}
        onClose={() => setShowCreateDm(false)}
        existingOneToOneUserIds={new Set(
          dmConversations
            .filter((c) => c.conversationType === "one_to_one")
            .flatMap((c) => (c.participantIds ?? []).filter((id) => id !== me?.internal_id))
        )}
        onCreated={(conversation) => {
          onConversationCreated(conversation);
          setViewMode("dm");
        }}
      />
      <CreateChannelModal
        open={showCreateChannel}
        onClose={() => setShowCreateChannel(false)}
        communityId={selectedCommunityId}
        onCreated={async () => {
          setGuildDataVersion((v) => v + 1);
        }}
      />
      <ManagePrivateChannelMembersModal
        open={showInviteMembers}
        onClose={() => setShowInviteMembers(false)}
        channelName={selectedChannel?.name ?? "private-channel"}
        currentUserId={me?.internal_id ?? ""}
        communityMembers={members}
        channelMembers={selectedChannelMembers}
        onInvite={handleInviteToPrivateChannel}
        onRemove={handleRemoveFromPrivateChannel}
      />

      {/* LEFT PANEL: icon nav + channel list stacked, with shared profile bar at bottom */}
      <div className="flex flex-col flex-shrink-0 w-[336px]">
        <div className="flex flex-1 overflow-hidden">
          {/* COLUMN 1: SideNavBar */}
          <aside className="bg-[#111318] w-20 flex flex-col items-center py-4 gap-4 flex-shrink-0">
            {/* Brand / Home */}
            <div className="group relative flex items-center justify-center w-full">
              <button
                type="button"
                title="Home"
                onClick={() => { setActivePanel("home"); setViewMode("dm"); }}
                className={activePanel === "home"
                  ? "bg-[#5865F2] text-white rounded-2xl w-12 h-12 flex items-center justify-center transition-all duration-300"
                  : "bg-[#171a1f] text-gray-400 rounded-[2rem] hover:rounded-2xl hover:bg-[#5865F2] hover:text-white w-12 h-12 flex items-center justify-center transition-all duration-300 cursor-pointer"
                }
              >
                <span className="material-symbols-outlined text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>
                  home
                </span>
              </button>
            </div>

            <div className="flex flex-col gap-4 items-center w-full overflow-y-auto pb-4">
              {communities.map((c) => {
                const active = activePanel === "server" && c.id === selectedCommunityId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    title={c.name}
                    onClick={() => {
                      setSelectedCommunityId(c.id);
                      setGuildName(c.name);
                      setActivePanel("server");
                      setViewMode("channel");
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

          {/* COLUMN 2: Home (DMs) or Server (Channels) */}
          <section className="flex-1 bg-surface-container-low flex flex-col overflow-hidden">
            <div className="h-16 flex items-center gap-2 px-4 font-headline font-bold text-lg text-on-surface flex-shrink-0 min-w-0">
              <span className="truncate flex-1 min-w-0">{activePanel === "home" ? "Direct Messages" : guildName}</span>
              {activePanel === "server" && usingLiveCommunities && selectedCommunityId ? (
                <div className="relative ml-auto flex-shrink-0" ref={guildMenuRef}>
                  <button
                    type="button"
                    aria-expanded={guildMenuOpen}
                    aria-haspopup="menu"
                    aria-label="Server options"
                    className="flex h-8 w-8 items-center justify-center rounded text-on-surface-variant hover:bg-surface-variant/60 hover:text-on-surface"
                    onClick={() => {
                      setLeaveError(null);
                      setGuildMenuOpen((o) => !o);
                    }}
                  >
                    <span
                      className={`material-symbols-outlined text-2xl transition-transform ${guildMenuOpen ? "rotate-180" : ""}`}
                    >
                      expand_more
                    </span>
                  </button>
                  {guildMenuOpen ? (
                    <div
                      role="menu"
                      className="absolute right-0 top-full z-[60] mt-1 min-w-[220px] rounded-lg border border-outline-variant/30 bg-[#111318] py-1 shadow-xl"
                    >
                      {leaveError ? (
                        <p className="px-3 py-2 text-xs text-red-400 border-b border-outline-variant/20">{leaveError}</p>
                      ) : null}
                      <button
                        type="button"
                        role="menuitem"
                        disabled={leaveBusy}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium text-red-400 hover:bg-white/5 disabled:opacity-50"
                        onClick={() => void handleLeaveCommunity()}
                      >
                        <span className="material-symbols-outlined text-[20px]" aria-hidden>
                          delete
                        </span>
                        {leaveBusy ? "Leaving…" : "Leave community"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <span className="material-symbols-outlined ml-auto flex-shrink-0 text-on-surface-variant opacity-40" aria-hidden>
                  expand_more
                </span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-1">
              {activePanel === "home" ? (
                <DmList
                  selectedId={selectedDmId}
                  onSelect={(c) => { setSelectedDmId(c.conversationId); setViewMode("dm"); }}
                  onNewDm={() => setShowCreateDm(true)}
                  conversations={dmConversations}
                  currentUserId={me?.internal_id ?? null}
                  dmUsers={dmUsers}
                  getPresence={getPresence}
                />
              ) : (
                <>
                  <div className="flex items-center justify-between px-2 pt-4 pb-1 text-on-surface-variant uppercase text-[10px] font-bold tracking-widest">
                    <span className="flex items-center">
                      <span className="material-symbols-outlined text-[14px] mr-1">expand_more</span>
                      Text Channels
                    </span>
                    {usingLiveCommunities && isGuildAdmin && selectedCommunityId ? (
                      <button
                        type="button"
                        title="Create channel"
                        className="p-0.5 rounded hover:bg-surface-variant/50 text-on-surface-variant hover:text-on-surface"
                        onClick={() => setShowCreateChannel(true)}
                      >
                        <span className="material-symbols-outlined text-[16px]">add</span>
                      </button>
                    ) : null}
                  </div>
                  {textChannels.map((c) => {
                    const active = viewMode === "channel" && c.id === selectedChannelId;
                    const needsJoin = c.joined === false;
                    return (
                      <div key={c.id} className="flex items-center gap-0.5 group/ch">
                        <button
                          type="button"
                          className={
                            active
                              ? "flex-1 min-w-0 flex items-center gap-2 px-2 py-2 rounded-lg bg-surface-container-highest text-on-surface font-semibold transition-all text-left"
                              : "flex-1 min-w-0 flex items-center gap-2 px-2 py-2 rounded-lg text-on-surface-variant hover:bg-surface-variant/50 hover:text-on-surface transition-all text-left"
                          }
                          onClick={() => {
                            setSelectedChannelId(c.id);
                            setViewMode("channel");
                            setSelectedDmId(null);
                          }}
                        >
                          <span className="material-symbols-outlined text-[18px] shrink-0 text-on-surface-variant">
                            {c.is_private ? "lock" : "tag"}
                          </span>
                          <span className="truncate">{c.name}</span>
                          {needsJoin ? (
                            <span className="ml-auto text-[9px] font-bold uppercase text-amber-400 shrink-0">Join</span>
                          ) : null}
                        </button>
                        {needsJoin ? (
                          <button
                            type="button"
                            title="Join channel"
                            className="shrink-0 px-1.5 py-1 rounded text-[10px] font-semibold bg-[#5865F2]/90 text-white hover:bg-[#4752c4]"
                            onClick={() => void handleJoinChannel(c.id)}
                          >
                            Join
                          </button>
                        ) : null}
                        {isGuildAdmin && usingLiveCommunities ? (
                          <>
                            {c.is_private ? (
                              <button
                                type="button"
                                title="Add members"
                                className="shrink-0 p-1 rounded opacity-0 group-hover/ch:opacity-100 hover:bg-[#5865F2]/20 text-[#8ea1ff]"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setSelectedChannelId(c.id);
                                  setViewMode("channel");
                                  void (async () => {
                                    if (selectedCommunityId) {
                                      const rows = await getChannelMembers(selectedCommunityId, c.id);
                                      setSelectedChannelMembers(rows ?? []);
                                    } else {
                                      setSelectedChannelMembers([]);
                                    }
                                  })();
                                  setShowInviteMembers(true);
                                }}
                              >
                                <span className="material-symbols-outlined text-[16px]">person_add</span>
                              </button>
                            ) : null}
                            <button
                              type="button"
                              title="Delete channel"
                              className="shrink-0 p-1 rounded opacity-0 group-hover/ch:opacity-100 hover:bg-red-500/20 text-red-400"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                void handleDeleteChannel(c.id);
                              }}
                            >
                              <span className="material-symbols-outlined text-[16px]">delete</span>
                            </button>
                          </>
                        ) : null}
                      </div>
                    );
                  })}
                </>
              )}
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
              onConversationLeft(id);
            }}
          />
        ) : channelAccessible && usingLiveCommunities && selectedChannel ? (
          <ChannelChatView
            channelId={selectedChannelId}
            channelName={selectedChannel.name}
            isPrivate={selectedChannel.is_private}
            communityId={selectedCommunityId ?? undefined}
            currentUserId={me?.internal_id ?? ""}
            currentUsername={me?.username ?? ""}
            wsEvent={latestChannelEvent}
          />
        ) : (
          <section className="flex-1 bg-surface-container flex flex-col relative min-w-0">
            <header className="h-16 flex items-center px-6 gap-3 bg-[#171a1f]/60 backdrop-blur-xl shadow-sm z-10">
              <span className="material-symbols-outlined text-on-surface-variant shrink-0">
                {selectedChannel?.is_private ? "lock" : "tag"}
              </span>
              <h1 className="text-[#f6f6fc] font-headline font-bold text-lg tracking-tight truncate">
                {selectedChannel?.name ?? "general-chat"}
              </h1>
            </header>
            {!channelAccessible && selectedChannel && usingLiveCommunities ? (
              <div className="border-b border-amber-500/25 bg-amber-500/10 px-6 py-4 flex flex-col gap-2">
                <p className="text-sm text-on-surface">
                  You are not a member of this channel yet. Join to read and send messages.
                </p>
                <button
                  type="button"
                  className="self-start rounded-lg bg-[#5865F2] hover:bg-[#4752c4] text-white text-sm font-semibold px-4 py-2"
                  onClick={() => void handleJoinChannel(selectedChannel.id)}
                >
                  Join channel
                </button>
              </div>
            ) : null}
            <div className="flex-1 flex items-center justify-center text-on-surface-variant text-sm">
              {!usingLiveCommunities ? "Select or join a community to start chatting." : "Select a channel."}
            </div>
          </section>
        )}

        {/* COLUMN 4: Members + presence (only in server/channel view) */}
        {activePanel === "server" && viewMode === "channel" && (
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
