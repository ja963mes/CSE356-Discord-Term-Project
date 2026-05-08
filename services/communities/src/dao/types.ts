export interface CommunityDirectoryRow {
  id: string;
  name: string;
  created_at: Date;
}

export interface UserCommunityRow {
  id: string;
  name: string;
  created_at: Date;
  role: string;
}

export interface CommunityMemberListRow {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  joined_at: string;
}

export interface ChannelListRow {
  id: string;
  name: string;
  type: string;
  position: number;
  is_private: boolean;
  joined: boolean;
}

export interface PrivateChannelMemberRow {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
}
