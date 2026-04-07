import { useCallback, useEffect, useState } from "react";
import { Conversation, listConversations } from "../api/dms";
import { Me } from "../api/auth";
import { IncomingMessage } from "./useWebSocket";

export function useDmEvents(me: Me | null) {
  const [dmConversations, setDmConversations] = useState<Conversation[]>([]);
  const [selectedDmId, setSelectedDmId] = useState<string | null>(null);
  const [latestDmEvent, setLatestDmEvent] = useState<IncomingMessage | null>(null);

  const handleDmMessage = useCallback((msg: IncomingMessage) => {
    if (typeof msg.type !== "string" || !msg.type.startsWith("dm:")) return;
    setLatestDmEvent(msg);
  }, []);

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
      listConversations().then(setDmConversations).catch((err) => { console.error("[useDmEvents] listConversations failed:", err); });
      return;
    }

    if (t === "dm:message:create") {
      const convId = latestDmEvent.conversationId as string | undefined;
      if (!convId) return;
      // Bump this conversation to the top
      setDmConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversationId === convId);
        if (idx <= 0) return prev; // already at top or not found
        const updated = [...prev];
        const [conv] = updated.splice(idx, 1);
        return [conv, ...updated];
      });
      return;
    }

    if (t === "dm:participant:leave") {
      const uid = latestDmEvent.userId as string | undefined;
      const deleted = latestDmEvent.conversationDeleted as boolean | undefined;
      const convId = latestDmEvent.conversationId as string | undefined;
      if (!convId) return;
      if (uid === me.internal_id || deleted) {
        setDmConversations((prev) => prev.filter((c) => c.conversationId !== convId));
        setSelectedDmId((prev) => (prev === convId ? null : prev));
      } else {
        listConversations().then(setDmConversations).catch((err) => { console.error("[useDmEvents] listConversations failed:", err); });
      }
    }
  }, [latestDmEvent, me]);

  function onConversationCreated(conversation: Conversation) {
    setDmConversations((prev) =>
      prev.some((c) => c.conversationId === conversation.conversationId)
        ? prev.map((c) => c.conversationId === conversation.conversationId ? conversation : c)
        : [conversation, ...prev]
    );
    setSelectedDmId(conversation.conversationId);
  }

  function onConversationLeft(id: string) {
    setDmConversations((prev) => prev.filter((c) => c.conversationId !== id));
    setSelectedDmId(null);
  }

  return {
    dmConversations,
    setDmConversations,
    selectedDmId,
    setSelectedDmId,
    latestDmEvent,
    handleDmMessage,
    onConversationCreated,
    onConversationLeft,
  };
}
