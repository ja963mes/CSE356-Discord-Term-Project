import React from "react";
import PresenceDot from "./PresenceDot";
import { PresenceState } from "../hooks/usePresence";

interface Props {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  presence: PresenceState;
  size?: "sm" | "md";
}

export default function UserPresence({ displayName, avatarUrl, presence, size = "md" }: Props) {
  const avatarSize = size === "sm" ? "w-8 h-8" : "w-10 h-10";
  const dotSize = size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5";
  const nameSize = size === "sm" ? "text-sm" : "text-base";
  const [imgFailed, setImgFailed] = React.useState(false);

  return (
    <div className="flex items-center gap-3">
      {/* Avatar */}
      <div className="relative flex-shrink-0">
        {avatarUrl && !imgFailed ? (
          <img
            src={avatarUrl}
            alt={displayName}
            className={`${avatarSize} rounded-full object-cover`}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className={`${avatarSize} rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant font-bold text-sm`}>
            {displayName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <PresenceDot status={presence.status} className={`absolute bottom-0 right-0 ${dotSize}`} />
      </div>

      {/* Name + away message */}
      <div className="flex-1 overflow-hidden">
        <p className={`${nameSize} font-semibold text-on-surface truncate`}>{displayName}</p>
        {presence.status === "away" && presence.awayMessage ? (
          <p className="text-[11px] text-on-surface-variant truncate">{presence.awayMessage}</p>
        ) : (
          <p className="text-[11px] text-on-surface-variant capitalize">{presence.status}</p>
        )}
      </div>
    </div>
  );
}
