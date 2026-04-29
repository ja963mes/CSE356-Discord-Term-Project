import WebSocket from 'ws';

export class CookieJar {
  readonly cookies = new Map<string, string>();

  set(name: string, value: string): void { this.cookies.set(name, value); }
  get(name: string): string | undefined { return this.cookies.get(name); }

  toHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(headers: Headers): void {
    const raw: string[] = (headers as any).getSetCookie?.() ??
      (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
    for (const h of raw) {
      const [pair] = h.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  clear(): void { this.cookies.clear(); }
  destroy(): void { this.cookies.clear(); }
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  jar?: CookieJar,
  retries = 3,
): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}) };
  if (jar) {
    const cookie = jar.toHeader();
    if (cookie) headers['Cookie'] = cookie;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(15_000) });
      if (jar) jar.absorb(res.headers);
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

interface RealtimeManagerOptions {
  url: () => string;
  headers: () => Record<string, string>;
  onMessage: (msg: unknown) => void;
}

export class RealtimeManager {
  private ws: WebSocket | null = null;
  private _enabled = false;
  private readonly opts: RealtimeManagerOptions;

  constructor(opts: RealtimeManagerOptions) {
    this.opts = opts;
  }

  async enable(timeout = 10_000): Promise<void> {
    if (this._enabled) return;
    this._enabled = true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('whenReady timeout')), timeout);
      const ws = new WebSocket(this.opts.url(), { headers: this.opts.headers() });
      this.ws = ws;
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('error', (err) => { clearTimeout(timer); if (!this._enabled) return; reject(err); });
      ws.on('message', (raw) => {
        try { this.opts.onMessage(JSON.parse(raw.toString())); } catch {}
      });
      ws.on('close', () => { this.ws = null; });
    });
  }

  async disable(): Promise<void> {
    this._enabled = false;
    this.ws?.close();
    this.ws = null;
  }

  async send(msg: unknown): Promise<void> {
    if (!this.ws || !this._enabled) throw new Error('RealtimeManager is not enabled');
    return new Promise((resolve, reject) => {
      this.ws!.send(JSON.stringify(msg), (err) => { if (err) reject(err); else resolve(); });
    });
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  destroy(): void {
    this._enabled = false;
    try { this.ws?.terminate(); } catch {}
    this.ws = null;
  }
}
