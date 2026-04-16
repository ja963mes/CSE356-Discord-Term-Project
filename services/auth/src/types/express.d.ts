declare global {
  namespace Express {
    interface User {
      internal_id: string;
    }
    interface Request {
      id?: string;
    }
  }
}

export {};