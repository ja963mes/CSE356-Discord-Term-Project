declare namespace Express {
  interface Request {
    user?: {
      internal_id: string;
    };
  }
}