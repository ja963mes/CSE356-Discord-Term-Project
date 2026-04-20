declare global {
  namespace Express {
    interface AuthUser {
      internal_id: string;
    }

    interface Request {
      user: AuthUser;
      /** Set by `pino-http` (`genReqId`). */
      id?: string;
    }
  }
}

export {};