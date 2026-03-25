import React, { useEffect, useMemo, useState } from "react";
import { Channel, Message, SearchResult, getChannels, getMessages, search } from "../api/discord";

const me = { name: "Neo_Architect", tag: "#9921" };

export default function ChatPage() {
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
          <div className="h-16 flex items-center px-4 font-headline font-bold text-lg text-on-surface">
            The Obsidian Architect
            <span className="material-symbols-outlined ml-auto text-on-surface-variant cursor-pointer">
              expand_more
            </span>
          </div>

          <div className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-1">
            <div className="flex items-center px-2 pt-4 pb-1 text-on-surface-variant uppercase text-[10px] font-bold tracking-widest">
              <span className="material-symbols-outlined text-[14px] mr-1">expand_more</span>
              Text Channels
            </div>

            {channels.map((c) => {
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

            {/* Placeholder voice section (wireframe layout) */}
            <div className="flex items-center px-2 pt-6 pb-1 text-on-surface-variant uppercase text-[10px] font-bold tracking-widest">
              <span className="material-symbols-outlined text-[14px] mr-1">expand_more</span>
              Voice Channels
            </div>
            <button className="flex items-center gap-2 px-2 py-2 rounded-lg text-on-surface-variant hover:bg-surface-variant/50 hover:text-on-surface group transition-all">
              <span className="material-symbols-outlined text-on-surface-variant group-hover:text-on-surface">
                volume_up
              </span>
              Main Lounge
            </button>
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
                {selectedChannel?.id ?? "general-chat"}
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
                placeholder="Message #general-chat"
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

