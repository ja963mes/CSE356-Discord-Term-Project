import { randomUUID } from "crypto";
import { db } from "../src/db";
import { kvRedis } from "../src/redis";
import { users, communities, communityMembers, channels, channelMembers } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { cassandra } from "../src/cassandra";
import { env } from "../src/env";

export interface TestUser {
  id: string;
  username: string;
  sessionToken: string;
  /** Cookie string to pass as Cookie header */
  cookie: string;
}

export interface TestChannel {
  channelId: string;
  communityId: string;
}

export async function createTestUser(): Promise<TestUser> {
  const id = randomUUID();
  const username = `testuser_${id.slice(0, 8)}`;
  await db.insert(users).values({
    internal_id: id,
    username,
    email: `${username}@test.local`,
    password_hash: "x",
  });

  const sessionToken = randomUUID();
  await kvRedis.set(`session:${sessionToken}`, id, "EX", 3600);

  return { id, username, sessionToken, cookie: `session_token=${sessionToken}` };
}

export async function createTestChannel(userId: string): Promise<TestChannel> {
  const communityId = randomUUID();
  const channelId = randomUUID();

  await db.insert(communities).values({ id: communityId, name: "Test Community", created_by: userId });
  await db.insert(communityMembers).values({ community_id: communityId, user_id: userId });
  await db.insert(channels).values({ id: channelId, community_id: communityId, name: "general", type: "text" });
  await db.insert(channelMembers).values({ channel_id: channelId, user_id: userId });

  return { channelId, communityId };
}

export async function addUserToChannel(userId: string, communityId: string, channelId: string): Promise<void> {
  await db.insert(communityMembers).values({ community_id: communityId, user_id: userId }).onConflictDoNothing();
  await db.insert(channelMembers).values({ channel_id: channelId, user_id: userId }).onConflictDoNothing();
}

export async function cleanupUser(userId: string): Promise<void> {
  await kvRedis.del(`session:*`); // quick cleanup for tests — fine since test redis is isolated
  await db.delete(users).where(eq(users.internal_id, userId));
}

export async function cleanupChannel(channelId: string, communityId: string): Promise<void> {
  const ks = env.MESSAGES_CASSANDRA_KEYSPACE;
  await cassandra.execute(`DELETE FROM ${ks}.messages_by_channel WHERE channel_id = ?`, [channelId]);
  await db.delete(channels).where(eq(channels.id, channelId));
  await db.delete(communities).where(eq(communities.id, communityId));
}
