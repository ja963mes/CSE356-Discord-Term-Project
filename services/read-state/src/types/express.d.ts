declare global {
  namespace Express {
    interface User {
      internal_id: string;
    }
  }
}

export {};
