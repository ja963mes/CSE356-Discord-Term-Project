function log(level: string, data: Record<string, unknown>, msg: string): void {
  process.stdout.write(
    JSON.stringify({ time: new Date().toISOString(), level, service: "dms-service", ...data, msg }) + "\n"
  );
}

export const logger = {
  info: (data: Record<string, unknown>, msg: string) => log("info", data, msg),
  warn: (data: Record<string, unknown>, msg: string) => log("warn", data, msg),
  error: (data: Record<string, unknown>, msg: string) => log("error", data, msg),
};
