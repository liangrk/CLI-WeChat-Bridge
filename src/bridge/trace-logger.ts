import fs from "node:fs";
import path from "node:path";

export class TraceLogger {
  private readonly traceDir: string;
  private currentStream: fs.WriteStream | null = null;
  private currentDate = "";

  constructor(traceDir: string) {
    this.traceDir = traceDir;
    fs.mkdirSync(traceDir, { recursive: true });
  }

  log(event: string, payload: Record<string, unknown>): void {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    if (dateStr !== this.currentDate) {
      this.rotateFile(dateStr);
    }

    const entry = JSON.stringify({
      timestamp: now.toISOString(),
      event,
      ...payload,
    });
    this.currentStream?.write(entry + "\n");
  }

  close(): void {
    this.currentStream?.end();
    this.currentStream = null;
  }

  private rotateFile(dateStr: string): void {
    if (this.currentStream) {
      this.currentStream.end();
    }
    this.currentDate = dateStr;
    const filename = `${dateStr}.trace.jsonl`;
    const filePath = path.join(this.traceDir, filename);
    this.currentStream = fs.createWriteStream(filePath, { flags: "a" });
  }
}
