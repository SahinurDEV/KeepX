import "express";

declare global {
  // Express publishes this as a namespace that apps are expected to augment.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      userId?: string;
      tokenHash?: string;
    }
  }
}
