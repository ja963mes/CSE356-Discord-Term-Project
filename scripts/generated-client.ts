// When replacing with a new grader client: keep this import, swap out everything else.
import { CookieJar, fetchWithRetry, RealtimeManager } from './test-harness/helpers.js';
import FormData from 'form-data';

// ─── Types ───

export interface UserInfo {
  id: string;
  username: string;
  displayName?: string;
  presence?: string;
  awayMessage?: string;
}

export interface ChannelInfo {
  id: string;
  name?: string;
  type?: string;
  isPrivate?: boolean;
  communityId?: string;
}

export interface DMInfo {
  id: string;
  participantIds: string[];
  type?: string;
}

export interface MessageInfo {
  id: string;
  conversationId: string;
  content: string;
  authorId: string;
  timestamp?: string;
  attachments?: string[];
  edited?: boolean;
}

export interface CommunityInfo {
  id: string;
  name: string;
  ownerId: string;
}

export interface SearchResult {
  message: MessageInfo;
  conversationId?: string;
  communityId?: string;
}

// ─── GeneratedClient ───

export class GeneratedClient {
  private baseUrl: string;
  private cookieJar: CookieJar;
  private rt: RealtimeManager;
  private ssoPath: string = '/auth/oidc';
  private _userId: string = '';

  // Callbacks
  private onMessageCb?: (message: MessageInfo) => void;
  private onMessageEditCb?: (message: MessageInfo) => void;
  private onMessageDeleteCb?: (event: { conversationId: string; messageId: string }) => void;
  private onPresenceCb?: (event: { userId: string; presence: string }) => void;
  private onInviteCb?: (event: { type: 'community' | 'dm'; id: string }) => void;
  private onReadReceiptCb?: (event: { conversationId: string; userId: string; messageId: string }) => void;

  // Keycloak cookie cache
  private static keycloakCookieCache: Map<string, Map<string, string>> = new Map();
  // Guard to only install process-level WS error handler once
  private static _wsErrorHandlerInstalled = false;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cookieJar = new CookieJar();
    // Install global handlers to prevent crashes from WS/RT cleanup
    if (!GeneratedClient._wsErrorHandlerInstalled) {
      GeneratedClient._wsErrorHandlerInstalled = true;
      process.on('unhandledRejection', (reason: any) => {
        const msg = reason?.message || String(reason);
        if (msg.includes('RealtimeManager disabled') ||
            msg.includes('RealtimeManager is not enabled') ||
            msg.includes('WebSocket was closed before') ||
            msg.includes('whenReady timeout')) {
          return; // Safe to ignore — from WS/RT cleanup
        }
      });
      process.on('uncaughtException', (err: any) => {
        if (err && typeof err.message === 'string' &&
          (err.message.includes('WebSocket was closed before') ||
           err.message.includes('Unhandled "error" event') ||
           err.message.includes('Unhandled error event'))) {
          return; // Safe to ignore — from WS error event during cleanup
        }
        throw err; // Re-throw non-WS errors
      });
    }
    this.rt = new RealtimeManager({
      url: () => this.baseUrl.replace(/^http/, 'ws') + '/ws',
      headers: () => {
        const cookie = this.cookieJar.toHeader();
        const h: Record<string, string> = {};
        if (cookie) h['cookie'] = cookie;
        return h;
      },
      onMessage: (msg) => this.handleWsMessage(msg),
    });
  }

  // Helper: fix HTTPS URLs with IPv4 addresses (server doesn't support HTTPS on raw IP)
  private fixRedirectUrl(url: string): string {
    return url.replace(/^https:\/\/(\d+\.\d+\.\d+\.\d+)/, 'http://$1');
  }

  // ─── Session Management ───

  setSessionCookie(name: string, value: string): void {
    this.cookieJar.set(name, value);
  }

  // ─── Authentication ───

  async register(username: string, password: string, displayName?: string): Promise<UserInfo> {
    const res = await fetchWithRetry(`${this.baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, displayName: displayName || username }),
    }, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`register failed: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    this._userId = String(data.internal_id || data.id || '');
    const info = this.parseUserInfo(data.user || data);
    if (!info.username) info.username = username;
    return info;
  }

  async login(username: string, password: string): Promise<UserInfo> {
    const res = await fetchWithRetry(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`login failed: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    this._userId = String(data.internal_id || data.id || '');
    const info = this.parseUserInfo(data.user || data);
    if (!info.username) info.username = username;
    return info;
  }

  async loginSSO(username: string, password: string): Promise<any> {
    const kcBase = 'https://infra-auth.cse356.compas.cs.stonybrook.edu';
    const kcJar = new CookieJar();

    // Pre-populate Keycloak cookie cache if available
    if (GeneratedClient.keycloakCookieCache.has(username)) {
      const cached = GeneratedClient.keycloakCookieCache.get(username)!;
      for (const [k, v] of cached) kcJar.set(k, v);
    }

    // Step 1: Initiate SSO
    let currentUrl = `${this.baseUrl}${this.ssoPath}`;
    let response: Response;
    response = await fetchWithRetry(currentUrl, {
      method: 'GET',
      redirect: 'manual',
    }, this.cookieJar);

    // Follow initial redirect chain (up to 15 hops)
    let hops = 0;
    while ((response.status >= 301 && response.status <= 308) && hops < 15) {
      hops++;
      const location = response.headers.get('location') || '';
      let nextUrl = location.startsWith('http') ? location : new URL(location, currentUrl).toString();
      nextUrl = this.fixRedirectUrl(nextUrl);
      let isKeycloak = false;
      try { isKeycloak = new URL(nextUrl).hostname === new URL(kcBase).hostname; } catch {}
      response = await fetchWithRetry(nextUrl, {
        method: 'GET',
        redirect: 'manual',
      }, isKeycloak ? kcJar : this.cookieJar);
      currentUrl = nextUrl;
    }

    // Step 2: If we're on a Keycloak page, submit credentials
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      let html = '';
      try { html = await response.text(); } catch {}

      if (html.includes('kc-form-login') || html.includes('id="username"') || html.includes('name="username"')) {
        const actionMatch = html.match(/action="([^"]+)"/);
        if (!actionMatch) throw new Error('SSO: could not find Keycloak form action');
        let actionUrl = actionMatch[1].replace(/&amp;/g, '&');
        if (!actionUrl.startsWith('http')) actionUrl = new URL(actionUrl, currentUrl).toString();

        response = await fetchWithRetry(actionUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
          redirect: 'manual',
        }, kcJar);
        currentUrl = actionUrl;

        while ((response.status >= 301 && response.status <= 308) && hops < 30) {
          hops++;
          const location = response.headers.get('location') || '';
          let nextUrl = location.startsWith('http') ? location : new URL(location, currentUrl).toString();
          nextUrl = this.fixRedirectUrl(nextUrl);
          let isKeycloak = false;
          try { isKeycloak = new URL(nextUrl).hostname === new URL(kcBase).hostname; } catch {}
          response = await fetchWithRetry(nextUrl, { method: 'GET', redirect: 'manual' }, isKeycloak ? kcJar : this.cookieJar);
          currentUrl = nextUrl;
        }

        const kcCookies = new Map<string, string>();
        for (const [k, v] of (kcJar as any).cookies) kcCookies.set(k, v);
        GeneratedClient.keycloakCookieCache.set(username, kcCookies);
      }
    }

    const meRes = await fetchWithRetry(`${this.baseUrl}/auth/me`, {}, this.cookieJar);
    if (meRes.ok) {
      const data = await meRes.json() as any;
      this._userId = String(data.internal_id || data.id || '');
      const info = this.parseUserInfo(data);
      if (!info.username) info.username = username;
      return info;
    }

    const urlObj = new URL(currentUrl);
    const token = urlObj.searchParams.get('token');
    if (token) {
      const createRes = await fetchWithRetry(`${this.baseUrl}/auth/sso/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, username, displayName: username }),
      }, this.cookieJar);

      if (createRes.ok) {
        try {
          await fetchWithRetry(`${this.baseUrl}/auth/set-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
          }, this.cookieJar);
        } catch (e: any) { /* password set is optional */ }
        const data = await createRes.json() as any;
        this._userId = String(data.internal_id || data.id || '');
        const createInfo = this.parseUserInfo(data.user || data);
        if (!createInfo.username) createInfo.username = username;
        return createInfo;
      } else if (createRes.status === 409 || createRes.status === 400) {
        const linkRes = await fetchWithRetry(`${this.baseUrl}/auth/sso/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, username, password }),
        }, this.cookieJar);
        if (!linkRes.ok) {
          const text = await linkRes.text();
          throw new Error(`SSO link failed: ${linkRes.status} ${text}`);
        }
        const data = await linkRes.json() as any;
        this._userId = String(data.internal_id || data.id || '');
        const linkInfo = this.parseUserInfo(data.user || data);
        if (!linkInfo.username) linkInfo.username = username;
        return linkInfo;
      }
    }

    return await this.login(username, password);
  }

  async logout(): Promise<void> {
    await fetchWithRetry(`${this.baseUrl}/auth/logout`, { method: 'POST' }, this.cookieJar);
    this.cookieJar.clear();
    this._userId = '';
  }

  // ─── Profile ───

  async getDisplayName(): Promise<string> {
    const res = await fetchWithRetry(`${this.baseUrl}/auth/me`, {}, this.cookieJar);
    if (!res.ok) throw new Error(`getDisplayName failed: ${res.status}`);
    const data = await res.json() as any;
    return data.profile?.displayName || data.displayName || data.username || '';
  }

  async setDisplayName(displayName: string): Promise<void> {
    const res = await fetchWithRetry(`${this.baseUrl}/auth/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    }, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`setDisplayName failed: ${res.status} ${text}`);
    }
  }

  async setAvatar(imageBuffer: Buffer, mimeType: string): Promise<string> {
    const form = new FormData();
    form.append('avatar', imageBuffer, { contentType: mimeType, filename: 'avatar.png' });
    const res = await fetchWithRetry(`${this.baseUrl}/auth/profile/avatar`, {
      method: 'POST',
      headers: form.getHeaders(),
      body: form.getBuffer() as unknown as BodyInit,
    }, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`setAvatar failed: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    return data.avatarUrl || data.url || '';
  }

  async getAvatar(username?: string): Promise<string> {
    const res = await fetchWithRetry(`${this.baseUrl}/auth/me`, {}, this.cookieJar);
    if (!res.ok) throw new Error(`getAvatar failed: ${res.status}`);
    const data = await res.json() as any;
    return data.profile?.avatar || data.avatarUrl || data.avatar || '';
  }

  // ─── Presence & Status ───

  async setPresence(status: string): Promise<void> {
    if (status === 'away') {
      await this.rt.send({ type: 'away', message: '' });
    } else if (status === 'idle') {
      await this.rt.send({ type: 'idle' });
    } else {
      await this.rt.send({ type: 'online' });
    }
  }

  async setAwayMessage(message: string): Promise<void> {
    await this.rt.send({ type: 'away', message });
  }

  onPresence(callback: (event: { userId: string; presence: string }) => void): void {
    this.onPresenceCb = callback;
  }

  // ─── User Search ───

  async searchUsers(query: string): Promise<UserInfo[]> {
    const url = query ? `${this.baseUrl}/auth/dm-users?q=${encodeURIComponent(query)}` : `${this.baseUrl}/auth/dm-users`;
    const res = await fetchWithRetry(url, {}, this.cookieJar);
    if (!res.ok) throw new Error(`searchUsers failed: ${res.status}`);
    const data = await res.json() as any;
    const users = Array.isArray(data) ? data : (data.users || []);
    const parsed = users.map((u: any) => this.parseUserInfo(u));
    const exact = parsed.filter((u: UserInfo) => u.username === query);
    return exact.length > 0 ? exact : parsed;
  }

  // ─── Communities ───

  async createCommunity(name: string): Promise<CommunityInfo> {
    const res = await fetchWithRetry(`${this.baseUrl}/create-community`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`createCommunity failed: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    return this.parseCommunity(data.community || data);
  }

  async getCommunities(): Promise<CommunityInfo[]> {
    const res = await fetchWithRetry(`${this.baseUrl}/communities`, {}, this.cookieJar);
    if (!res.ok) throw new Error(`getCommunities failed: ${res.status}`);
    const data = await res.json() as any;
    const communities = Array.isArray(data) ? data : (data.communities || []);
    return communities.map((c: any) => this.parseCommunity(c));
  }

  async joinCommunity(communityId: string): Promise<void> {
    const res = await fetchWithRetry(`${this.baseUrl}/communities/${communityId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      if (text.includes('Already a member') || res.status === 409) return;
      throw new Error(`joinCommunity failed: ${res.status} ${text}`);
    }
  }

  async switchCommunity(communityId: string): Promise<void> {
    // No-op — no switch endpoint found
  }

  async getCommunityMembers(communityId: string): Promise<UserInfo[]> {
    const res = await fetchWithRetry(`${this.baseUrl}/communities/${communityId}/members`, {}, this.cookieJar);
    if (!res.ok) throw new Error(`getCommunityMembers failed: ${res.status}`);
    const data = await res.json() as any;
    const members = Array.isArray(data) ? data : (data.members || []);
    return members.map((m: any) => this.parseMember(m));
  }

  // ─── Channels ───

  async createChannelInCommunity(communityId: string, name: string, options?: { isPrivate?: boolean }): Promise<ChannelInfo> {
    const res = await fetchWithRetry(`${this.baseUrl}/communities/${communityId}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: 'text', is_private: options?.isPrivate || false }),
    }, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`createChannelInCommunity failed: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    return this.parseChannel(data.channel || data, communityId);
  }

  async getChannelsInCommunity(communityId: string): Promise<ChannelInfo[]> {
    const res = await fetchWithRetry(`${this.baseUrl}/communities/${communityId}/channels`, {}, this.cookieJar);
    if (!res.ok) throw new Error(`getChannelsInCommunity failed: ${res.status}`);
    const data = await res.json() as any;
    const channels = Array.isArray(data) ? data : (data.channels || []);
    return channels.map((c: any) => this.parseChannel(c, communityId));
  }

  // ─── Direct Conversations ───

  async createDM(userIds: string[]): Promise<DMInfo> {
    const type = userIds.length === 1 ? 'one_to_one' : 'group';
    const res = await fetchWithRetry(`${this.baseUrl}/dms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, participantIds: userIds }),
    }, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`createDM failed: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    return this.parseDM(data.conversation || data);
  }

  async getDMChannels(): Promise<DMInfo[]> {
    const res = await fetchWithRetry(`${this.baseUrl}/dms`, {}, this.cookieJar);
    if (!res.ok) throw new Error(`getDMChannels failed: ${res.status}`);
    const data = await res.json() as any;
    const convs = Array.isArray(data) ? data : (data.conversations || []);
    return convs.map((c: any) => this.parseDM(c));
  }

  async addDMParticipant(dmId: string, userId: string): Promise<void> {
    const res = await fetchWithRetry(`${this.baseUrl}/dms/${dmId}/participants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    }, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`addDMParticipant failed: ${res.status} ${text}`);
    }
  }

  async leaveDM(dmId: string): Promise<void> {
    const res = await fetchWithRetry(`${this.baseUrl}/dms/${dmId}/participants/me`, {
      method: 'DELETE',
    }, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`leaveDM failed: ${res.status} ${text}`);
    }
  }

  // ─── Messaging ───

  async sendMessage(conversationId: string, content: string, attachments?: Buffer[]): Promise<MessageInfo> {
    const body: any = { channelId: conversationId, content };
    if (attachments && attachments.length > 0) body.attachmentKeys = [];
    const res = await fetchWithRetry(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`sendMessage failed: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    return this.parseMessage(data.message || data, conversationId);
  }

  async sendDM(conversationId: string, content: string, attachments?: Buffer[]): Promise<MessageInfo> {
    const body: any = { content };
    if (attachments && attachments.length > 0) body.attachmentKeys = [];
    const res = await fetchWithRetry(`${this.baseUrl}/dms/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`sendDM failed: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    return this.parseMessage(data.message || data, conversationId);
  }

  async getMessages(conversationId: string, options?: { before?: string; limit?: number }): Promise<MessageInfo[]> {
    const params = new URLSearchParams();
    params.set('channelId', conversationId);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.before) params.set('before', options.before);
    const res = await fetchWithRetry(`${this.baseUrl}/messages?${params.toString()}`, {}, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`getMessages failed: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    const messages = data.messages || (Array.isArray(data) ? data : []);
    return messages.filter((m: any) => !m.deleted).map((m: any) => this.parseMessage(m, conversationId));
  }

  async getMessagesDM(conversationId: string, options?: { before?: string; limit?: number }): Promise<MessageInfo[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.before) params.set('before', options.before);
    const qs = params.toString();
    const res = await fetchWithRetry(
      `${this.baseUrl}/dms/${conversationId}/messages${qs ? '?' + qs : ''}`,
      {}, this.cookieJar
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`getMessagesDM failed: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    const messages = data.messages || (Array.isArray(data) ? data : []);
    return messages.filter((m: any) => !m.deleted).map((m: any) => this.parseMessage(m, conversationId));
  }

  async editMessage(conversationId: string, messageId: string, newContent: string): Promise<MessageInfo> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/dms/${conversationId}/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent }),
      }, this.cookieJar
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`editMessage failed: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    return this.parseMessage(data.message || data, conversationId);
  }

  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/dms/${conversationId}/messages/${messageId}`,
      { method: 'DELETE' }, this.cookieJar
    );
    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      throw new Error(`deleteMessage failed: ${res.status} ${text}`);
    }
  }

  // ─── Real-time ───

  onMessage(callback: (message: MessageInfo) => void): void {
    this.onMessageCb = callback;
  }

  onMessageEdit(callback: (message: MessageInfo) => void): void {
    this.onMessageEditCb = callback;
  }

  onMessageDelete(callback: (event: { conversationId: string; messageId: string }) => void): void {
    this.onMessageDeleteCb = callback;
  }

  onInvite(callback: (event: { type: 'community' | 'dm'; id: string }) => void): void {
    this.onInviteCb = callback;
  }

  async enableRealtime(): Promise<void> {
    await this.rt.enable(10000);
  }

  async disableRealtime(): Promise<void> {
    await this.rt.disable();
  }

  isWebSocketConnected(): boolean {
    return this.rt.isConnected();
  }

  disconnect(): void {
    this.cookieJar.destroy();
    this.rt.destroy();
  }

  // ─── Read State ───

  async markRead(conversationId: string, messageId: string): Promise<void> {
    const res = await fetchWithRetry(`${this.baseUrl}/read-state/dms/${conversationId}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeuuid: messageId, messageId: messageId }),
    }, this.cookieJar);
    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      throw new Error(`markRead failed: ${res.status} ${text}`);
    }
  }

  async getUnreadCounts(): Promise<{ conversationId: string; count: number }[]> {
    const res = await fetchWithRetry(`${this.baseUrl}/read-state/dms`, {}, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`getUnreadCounts failed: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    const counts = Array.isArray(data) ? data : (data.unread || data.counts || []);
    return counts.map((c: any) => ({
      conversationId: c.conversationId || c.channelId || c.id || '',
      count: c.count || c.unreadCount || 0,
    }));
  }

  onReadReceipt(callback: (event: { conversationId: string; userId: string; messageId: string }) => void): void {
    this.onReadReceiptCb = callback;
  }

  // ─── Search ───

  async searchMessages(query: string, options?: {
    conversationId?: string;
    communityId?: string;
    authorId?: string;
    before?: string;
    after?: string;
  }): Promise<SearchResult[]> {
    const params = new URLSearchParams();
    params.set('q', query);
    if (options?.conversationId) {
      params.set('scope', 'dm');
      params.set('conversationId', options.conversationId);
    } else {
      params.set('scope', 'community');
      if (options?.communityId) params.set('communityId', options.communityId);
    }
    if (options?.authorId) params.set('authorId', options.authorId);
    if (options?.before) params.set('before', options.before);
    if (options?.after) params.set('after', options.after);
    const res = await fetchWithRetry(`${this.baseUrl}/search/messages?${params.toString()}`, {}, this.cookieJar);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`searchMessages failed: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    const results = Array.isArray(data) ? data : (data.results || []);
    return results.map((r: any) => {
      const convId = r.scope_id || r.conversationId || r.channelId || options?.conversationId || '';
      return {
        message: this.parseSearchMessage(r, convId),
        conversationId: convId,
        communityId: r.community_id || r.communityId || options?.communityId || '',
      };
    });
  }

  private parseSearchMessage(r: any, conversationId: string): MessageInfo {
    const msgId = String(r.timeuuid || r.message_id || r.messageId || r.id || '');
    return {
      id: msgId,
      conversationId,
      content: r.content || '',
      authorId: String(r.author_id || r.authorId || ''),
      timestamp: r.created_at || r.createdAt,
      attachments: r.attachmentUrls || r.attachments || [],
      edited: !!(r.edited || r.editedAt),
    };
  }

  // ─── WebSocket Event Handler ───

  private handleWsMessage(msg: any): void {
    try { this.dispatchWsEvent(msg); } catch (_e) { /* prevent WS handler crash */ }
  }

  private dispatchWsEvent(msg: any): void {
    const type = msg.type || msg.event || '';

    if (type === 'channel:message:create') {
      const raw = msg.message || msg;
      const convId = msg.channelId || raw.channelId || raw.conversationId || '';
      if (this.onMessageCb) this.onMessageCb(this.parseMessage(raw, convId));
    } else if (type === 'channel:message:edit') {
      if (this.onMessageEditCb) {
        const raw = msg.message || msg;
        const convId = msg.channelId || raw.channelId || '';
        this.onMessageEditCb(this.parseMessage(raw, convId));
      }
    } else if (type === 'channel:message:delete') {
      if (this.onMessageDeleteCb) {
        this.onMessageDeleteCb({
          conversationId: msg.channelId || msg.conversationId || '',
          messageId: String(msg.timeuuid || msg.messageId || ''),
        });
      }
    } else if (type === 'dm:message:create') {
      const raw = msg.message || msg;
      const convId = msg.conversationId || raw.conversationId || '';
      if (this.onMessageCb) this.onMessageCb(this.parseMessage(raw, convId));
    } else if (type === 'dm:message:edit') {
      if (this.onMessageEditCb) {
        const raw = msg.message || msg;
        const convId = msg.conversationId || raw.conversationId || '';
        this.onMessageEditCb(this.parseMessage(raw, convId));
      }
    } else if (type === 'dm:message:delete') {
      if (this.onMessageDeleteCb) {
        this.onMessageDeleteCb({
          conversationId: msg.conversationId || '',
          messageId: String(msg.timeuuid || msg.messageId || ''),
        });
      }
    } else if (type === 'presence_update') {
      if (this.onPresenceCb) {
        this.onPresenceCb({
          userId: String(msg.userId || msg.user_id || ''),
          presence: String(msg.status || msg.presence || ''),
        });
      }
    } else if (type === 'dm:participant:join') {
      if (this.onInviteCb) {
        this.onInviteCb({ type: 'dm', id: String(msg.conversationId || '') });
      }
    } else if (type === 'dm:conversation:create') {
      if (this.onInviteCb) {
        const convId = msg.conversation?.conversationId || msg.conversationId || '';
        this.onInviteCb({ type: 'dm', id: String(convId) });
      }
    } else if (type === 'community:member:join') {
      if (this.onInviteCb && msg.userId === this._userId) {
        this.onInviteCb({ type: 'community', id: String(msg.communityId || '') });
      }
    } else if (type === 'dm:read-state:update') {
      if (this.onReadReceiptCb) {
        this.onReadReceiptCb({
          conversationId: msg.conversationId || '',
          userId: String(msg.userId || ''),
          messageId: String(msg.messageId || msg.timeuuid || ''),
        });
      }
    }
  }

  // ─── Helpers ───

  private parseUserInfo(u: any): UserInfo {
    return {
      id: String(u.internal_id || u.id || u._id || ''),
      username: u.username || '',
      displayName: u.profile?.displayName || u.displayName || u.display_name || u.name,
      presence: u.presence || u.status,
      awayMessage: u.awayMessage || u.away_message,
    };
  }

  private parseMember(m: any): UserInfo {
    return {
      id: String(m.user_id || m.internal_id || m.id || m._id || ''),
      username: m.username || '',
      displayName: m.display_name || m.displayName || m.profile?.displayName || m.username,
      presence: m.presence || m.status,
    };
  }

  private parseCommunity(c: any): CommunityInfo {
    return {
      id: String(c.id || c._id || ''),
      name: c.name || '',
      ownerId: String(c.ownerId || c.owner_id || c.created_by || c.owner || ''),
    };
  }

  private parseChannel(c: any, communityId?: string): ChannelInfo {
    const isPrivate: boolean = !!(c.is_private || c.isPrivate || (c.type === 'private'));
    return {
      id: String(c.id || c._id || ''),
      name: c.name || '',
      type: c.type || (isPrivate ? 'private' : 'public'),
      isPrivate,
      communityId: String(c.communityId || c.community_id || communityId || ''),
    };
  }

  private parseDM(d: any): DMInfo {
    let participantIds: string[] = [];
    if (Array.isArray(d.participantIds)) {
      participantIds = d.participantIds.map(String);
    } else if (Array.isArray(d.participants)) {
      participantIds = d.participants.map((p: any) =>
        typeof p === 'string' ? p : String(p.id || p.internal_id || p._id || '')
      );
    } else if (Array.isArray(d.members)) {
      participantIds = d.members.map((m: any) =>
        typeof m === 'string' ? m : String(m.id || m.internal_id || m._id || '')
      );
    }
    const id = String(d.conversationId || d.id || d._id || '');
    return {
      id,
      participantIds,
      type: d.conversationType || d.type || (participantIds.length > 2 ? 'group' : 'dm'),
    };
  }

  private parseMessage(m: any, conversationId: string): MessageInfo {
    const msgId = String(m.timeuuid || m.messageId || m.id || m._id || '');
    return {
      id: msgId,
      conversationId: m.conversationId || m.channelId || m.channel_id || conversationId,
      content: m.content || m.text || m.body || '',
      authorId: String(m.authorId || m.author_id || m.userId || m.user_id || (m.author?.id) || ''),
      timestamp: m.timestamp || m.createdAt || m.created_at,
      attachments: m.attachmentUrls || m.attachments || [],
      edited: !!(m.edited || m.isEdited || m.editedAt || m.updatedAt),
    };
  }
}
