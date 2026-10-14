import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodTypeAny } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function zodDetails(error: ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export function parseBody<T>(schema: ZodTypeAny, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(400, "VALIDATION_ERROR", "The request is invalid.", zodDetails(result.error));
  }
  return result.data as T;
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const requestId = req.requestId;
  if (error instanceof HttpError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details, requestId },
    });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "The request is invalid.",
        details: zodDetails(error),
        requestId,
      },
    });
    return;
  }
  console.error(JSON.stringify({ level: "error", requestId, message: error instanceof Error ? error.message : "error" }));
  res.status(500).json({
    error: { code: "INTERNAL", message: "Something went wrong.", requestId },
  });
};

export function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: number }).code === 11000;
}
