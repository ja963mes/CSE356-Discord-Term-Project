declare global {
  namespace Express {
    interface User {
      internal_id: string;
    }
    interface Request {
      /** Set by `pino-http` (`genReqId`). */
      id?: string;
    }
  }
}

export {};
