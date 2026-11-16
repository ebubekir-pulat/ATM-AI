import type { NextFunction, Request, Response } from "express";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    const message = err.status === 500 ? "Something went wrong." : err.message;
    res.status(err.status).json({ error: { code: err.code, message } });
    return;
  }

  console.error(err);
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong." } });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found." } });
}
