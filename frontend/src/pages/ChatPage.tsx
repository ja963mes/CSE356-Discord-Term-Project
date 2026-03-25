import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Channel, Message, SearchResult, getChannels, getMessages, search } from "../api/discord";
import { getMe, getDmUsers, Me, DmUser } from "../api/auth";
import { useWebSocket } from "../hooks/useWebSocket";
import { useActivityDetection } from "../hooks/useActivityDetection";
import { usePresence } from "../hooks/usePresence";
import UserPresence from "../components/UserPresence";

export default function ChatPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [dmUsers, setDmUsers] = useState<DmUser[]>([]);

  const { handleMessage: handlePresenceMessage, getPresence, setPresence } = usePresence();

  const handleMessage = useCallback((msg: import("../hooks/useWebSocket").IncomingMessage) => {
    console.log("[ws] incoming:", msg);
    handlePresenceMessage(msg);
  }, [handlePresenceMessage]);

  useEffect(() => {
    getMe().then((data) => {
      setMe(data);
      setPresence(data.internal_id, { status: data.presence as import("../hooks/usePresence").PresenceStatus });
    }).catch(() => setMe(null));
    getDmUsers().then(setDmUsers).catch(() => setDmUsers([]));
  }, [setPresence]);

  const { send } = useWebSocket(handleMessage);
  useActivityDetection(send);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string>("general-chat");
  const [messages, setMessages] = useState<Message[]>([]);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  useEffect(() => {
    getChannels()
      .then((chs) => {
        setChannels(chs);
        if (chs.length > 0) setSelectedChannelId((prev) => chs.some((c) => c.id === prev) ? prev : chs[0].id);
      })
      .catch(() => {
        // Stub data is optional at this stage.
      });
  }, []);

  useEffect(() => {
    getMessages(selectedChannelId)
      .then(setMessages)
      .catch(() => setMessages([]));
  }, [selectedChannelId]);

  const selectedChannel = useMemo(() => channels.find((c) => c.id === selectedChannelId), [channels, selectedChannelId]);

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

  return (
    <div className="flex h-screen w-full">
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
          <div className="flex items-center justify-center w-full">
            <div className="bg-[#171a1f] text-primary rounded-[2rem] hover:rounded-2xl transition-all duration-300 w-12 h-12 flex items-center justify-center hover:bg-primary-dim hover:text-on-primary cursor-pointer group-active:scale-95">
              <span className="material-symbols-outlined text-2xl">add</span>
            </div>
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

          <div className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-1">

            {/* TODO: replace with real DM conversations once Direct Conversations service is built */}
            <div className="flex items-center px-2 pt-6 pb-1 text-on-surface-variant uppercase text-[10px] font-bold tracking-widest">
              <span className="material-symbols-outlined text-[14px] mr-1">expand_more</span>
              Direct Messages
            </div>
            {dmUsers.map((u) => (
              <div key={u.internal_id} className="px-2 py-1.5 rounded-lg hover:bg-surface-variant/50 cursor-pointer transition-all">
                <UserPresence
                  userId={u.internal_id}
                  displayName={u.profile.displayName}
                  avatarUrl={u.profile.avatar ?? undefined}
                  presence={getPresence(u.internal_id)}
                  size="sm"
                />
              </div>
            ))}
          </div>

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
                Empty chat
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
          <div className="flex-1 flex items-center justify-center">
            <p className="text-on-surface-variant text-sm">Empty chat</p>
          </div>

          {/* Message Composer */}
          <div className="p-4 border-t border-outline-variant/20">
            <div className="flex items-center gap-3">
              <input
                className="flex-1 bg-surface-container-lowest border-none rounded-lg px-4 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:ring-1 focus:ring-primary"
                placeholder="Message empty chat"
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
      </main>
    </div>
  );
}

