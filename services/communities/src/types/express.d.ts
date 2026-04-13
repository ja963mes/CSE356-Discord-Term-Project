declare global {
  namespace Express {
    /** Session user set by `requireAuth` (Redis lookup of `session:{token}`). */
    interface User {
      internal_id: string;
    }

    interface Request {
      /** Correlation id set by `requestLog` middleware. */
      reqId?: string;
    }
  }
}

export {};
