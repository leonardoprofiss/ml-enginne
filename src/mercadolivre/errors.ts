export class MlApiError extends Error {
  constructor(
    public status: number,
    public mlErrorCode: string | undefined,
    message: string,
    public path: string
  ) {
    super(message);
    this.name = "MlApiError";
  }
}

export class MlRateLimitError extends MlApiError {
  constructor(path: string, public retryAfterMs: number) {
    super(429, "local_rate_limited", `Rate limit atingido em ${path}`, path);
    this.name = "MlRateLimitError";
  }
}
