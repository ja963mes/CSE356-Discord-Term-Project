import React from "react";
import { PresenceStatus } from "../hooks/usePresence";

interface Props {
  status: PresenceStatus;
  className?: string;
}

const statusStyles: Record<PresenceStatus, string> = {
  online: "bg-emerald-500",
  idle:   "bg-yellow-400",
  away:   "bg-orange-400",
  offline: "bg-gray-500",
};

export default function PresenceDot({ status, className = "" }: Props) {
  return (
    <span
      className={`block rounded-full border-2 border-surface-container-lowest ${statusStyles[status]} ${className}`}
      title={status}
    />
  );
}
