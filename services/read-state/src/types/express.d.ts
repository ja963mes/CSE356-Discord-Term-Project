declare global {
  namespace Express {
    interface User {
      internal_id: string;
    }
    interface Request {
      user?: User;
    }
  }
}

export {};
