import React, { useCallback, useEffect, useMemo, useState } from "react";
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
  sendPresenceHeartbeat,
  search,
} from "../api/discord";
import {
  CreateCommunityModal,
  JoinCommunityPlaceholderModal,
  ServerActionMenuModal,
} from "../components/CommunityModals";

const me = { name: "Neo_Architect", tag: "#9921" };

type CommunityModal = "none" | "menu" | "create" | "join";

export default function ChatPage() {
  const [communities, setCommunities] = useState<Community[]>([]);
  const [selectedCommunityId, setSelectedCommunityId] = useState<string | null>(null);
  const [guildName, setGuildName] = useState("The Obsidian Architect");
  const [usingLiveCommunities, setUsingLiveCommunities] = useState(false);
  const [communityModal, setCommunityModal] = useState<CommunityModal>("none");

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
    return () => {
      cancelled = true;
    };
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
    return () => {
      cancelled = true;
    };
  }, [usingLiveCommunities, selectedCommunityId]);

  useEffect(() => {
    getMessages(selectedChannelId)
      .then(setMessages)
      .catch(() => setMessages([]));
  }, [selectedChannelId]);

  useEffect(() => {
    if (!usingLiveCommunities || !selectedCommunityId) return;
    sendPresenceHeartbeat("online");
    const id = window.setInterval(() => {
      void sendPresenceHeartbeat("online");
    }, 25_000);
    return () => {
      window.clearInterval(id);
      void sendPresenceHeartbeat("offline");
    };
  }, [usingLiveCommunities, selectedCommunityId]);

  const selectedChannel = useMemo(() => channels.find((c) => c.id === selectedChannelId), [channels, selectedChannelId]);

  const textChannels = useMemo(() => channels.filter((c) => c.type === "text"), [channels]);
  const voiceChannels = useMemo(() => channels.filter((c) => c.type === "voice"), [channels]);

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
      case "online":
        return "bg-emerald-500";
      case "idle":
        return "bg-amber-400";
      case "dnd":
        return "bg-red-500";
      default:
        return "bg-zinc-500";
    }
  }

  function presenceLabel(status: string) {
    switch (status) {
      case "online":
        return "Online";
      case "idle":
        return "Idle";
      case "dnd":
        return "Do not disturb";
      default:
        return "Offline";
    }
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

      {/* COLUMN 1: SideNavBar */}
      <aside className="fixed left-0 top-0 h-full flex flex-col z-50 bg-[#111318] h-screen w-20 flex flex-col items-center py-4 gap-4 no-border shadow-none">
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
          {communities.length === 0 ? (
            <>
              <div className="flex items-center justify-center w-full">
                <div className="bg-[#171a1f] text-gray-400 rounded-[2rem] hover:rounded-2xl transition-all duration-300 w-12 h-12 flex items-center justify-center hover:bg-[#5865F2] hover:text-white cursor-pointer group-active:scale-95">
                  <span className="material-symbols-outlined text-2xl">sports_esports</span>
                </div>
              </div>
              <div className="flex items-center justify-center w-full">
                <div className="bg-[#171a1f] text-gray-400 rounded-[2rem] hover:rounded-2xl transition-all duration-300 w-12 h-12 flex items-center justify-center hover:bg-[#5865F2] hover:text-white cursor-pointer group-active:scale-95">
                  <span className="material-symbols-outlined text-2xl">palette</span>
                </div>
              </div>
              <div className="flex items-center justify-center w-full">
                <div className="bg-[#171a1f] text-gray-400 rounded-[2rem] hover:rounded-2xl transition-all duration-300 w-12 h-12 flex items-center justify-center hover:bg-[#5865F2] hover:text-white cursor-pointer group-active:scale-95">
                  <span className="material-symbols-outlined text-2xl">terminal</span>
                </div>
              </div>
            </>
          ) : null}
          <div className="flex items-center justify-center w-full">
            <button
              type="button"
              title="Add a server"
              onClick={() => setCommunityModal("menu")}
              className="bg-[#171a1f] text-primary rounded-[2rem] hover:rounded-2xl transition-all duration-300 w-12 h-12 flex items-center justify-center hover:bg-primary-dim hover:text-on-primary cursor-pointer group-active:scale-95 border-0"
            >
              <span className="material-symbols-outlined text-2xl">add</span>
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-auto flex flex-col gap-4 items-center w-full">
          <div className="w-12 h-12 rounded-full overflow-hidden border-2 border-transparent hover:border-primary transition-colors">
            <img
              className="w-full h-full object-cover"
              alt="User profile avatar"
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuBahDzQYQoMx_ESgcbbeHqFsUjD4l5yPWSo_K8E-DxeTTObkD3AV7uiB-oq7RK1m50NTGUUSGAvMW385Kg1LTsImISfcXdyie2G5vMT58TRZ8HgKmK3SxrnbmAYEw0wtSZGYB946DCT3kniNWi9jxg_xET6swk694o5l9rPlj3JTX-tSOzxiBVQQaAk-fX33ldzjlRh9QPjOCZXVbgMUEo51eT0yp9J_K1rAY_bxxFOOAANFPmNR7B3AfQqSOcu9cj8TbqzYm9NW_U"
            />
          </div>
        </div>
      </aside>

      {/* MAIN WRAPPER */}
      <main className="flex w-full ml-20 h-screen overflow-hidden">
        {/* COLUMN 2: Channel List */}
        <section className="w-64 bg-surface-container-low flex flex-col flex-shrink-0">
          <div className="h-16 flex items-center px-4 font-headline font-bold text-lg text-on-surface">
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
              const active = c.id === selectedChannelId;
              return (
                <button
                  key={c.id}
                  className={
                    active
                      ? "flex items-center gap-2 px-2 py-2 rounded-lg bg-surface-container-highest text-on-surface font-semibold group transition-all"
                      : "flex items-center gap-2 px-2 py-2 rounded-lg text-on-surface-variant hover:bg-surface-variant/50 hover:text-on-surface group transition-all"
                  }
                  onClick={() => setSelectedChannelId(c.id)}
                >
                  <span className="material-symbols-outlined text-on-surface-variant group-hover:text-on-surface">
                    tag
                  </span>
                  {c.name}
                </button>
              );
            })}

            <div className="flex items-center px-2 pt-6 pb-1 text-on-surface-variant uppercase text-[10px] font-bold tracking-widest">
              <span className="material-symbols-outlined text-[14px] mr-1">expand_more</span>
              Voice Channels
            </div>
            {voiceChannels.length > 0 ? (
              voiceChannels.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="flex items-center gap-2 px-2 py-2 rounded-lg text-on-surface-variant hover:bg-surface-variant/50 hover:text-on-surface group transition-all"
                >
                  <span className="material-symbols-outlined text-on-surface-variant group-hover:text-on-surface">
                    volume_up
                  </span>
                  {c.name}
                </button>
              ))
            ) : (
              <button className="flex items-center gap-2 px-2 py-2 rounded-lg text-on-surface-variant hover:bg-surface-variant/50 hover:text-on-surface group transition-all">
                <span className="material-symbols-outlined text-on-surface-variant group-hover:text-on-surface">
                  volume_up
                </span>
                Main Lounge
              </button>
            )}
          </div>

          <div className="p-2 bg-surface-container-lowest flex items-center gap-3">
            <div className="relative">
              <img
                className="w-8 h-8 rounded-full"
                alt="Self user avatar"
                src="https://lh3.googleusercontent.com/aida-public/AB6AXuA9LGtaqFYYezmeHm0w1uyea5hhxikzo0BeZequRGWnnUkPCfJYQqsi-SvrfSc7bTEH2zN-nB3OehoR2Pe1dGQcSIV-BTU7X909usxl9_KXU09luJfqE8KfDEgpxPVUAOq7Y1lhq_nCoEq_LYR5ISaN471rB5nJj8afHnKMjyFsCUqJN6xa789XdkqwWBCehfPyBW4TF5pVCOttBM0z0psxKPREqEketjnG_KUka14iKeajg1Nd4HDIkyMdbf5rE0MAo2_2dL0tyhKQ"
              />
              <div className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 border-2 border-surface-container-lowest rounded-full" />
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="text-sm font-bold text-on-surface truncate">{me.name}</p>
              <p className="text-[10px] text-on-surface-variant">{me.tag}</p>
            </div>
            <div className="flex gap-1 text-on-surface-variant">
              <span className="material-symbols-outlined text-lg p-1 hover:bg-surface-container-high rounded transition-colors cursor-pointer">
                mic
              </span>
              <span className="material-symbols-outlined text-lg p-1 hover:bg-surface-container-high rounded transition-colors cursor-pointer">
                settings
              </span>
            </div>
          </div>
        </section>

        {/* COLUMN 3: Main Chat Area */}
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
                <a className="text-[#9fa7ff] font-bold" href="#">
                  Threads
                </a>
                <a className="text-gray-400 hover:text-[#f6f6fc] transition-colors" href="#">
                  Pins
                </a>
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

        {/* COLUMN 4: Members + presence */}
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
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-variant/40"
                >
                  <div className="relative flex-shrink-0">
                    <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant text-xs">
                      {m.display_name.slice(0, 1).toUpperCase()}
                    </div>
                    <div
                      className={`absolute bottom-0 right-0 w-2.5 h-2.5 border-2 border-surface-container-low rounded-full ${presenceDotClass(m.presence.status)}`}
                      title={presenceLabel(m.presence.status)}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-on-surface truncate">{m.display_name}</p>
                    <p className="text-[10px] text-on-surface-variant truncate">{presenceLabel(m.presence.status)}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
