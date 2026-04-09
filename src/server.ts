import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { Logger } from "./logger";

const CONFIG_DIR = path.join(os.homedir(), ".config", "agent-notify");
const PORT_FILE = path.join(CONFIG_DIR, "port");
const MAX_PAYLOAD = 64 * 1024; // 64KB

export type NotifyHandler = (
  source: string,
  payload: Record<string, unknown>
) => void;

export class NotificationServer {
  private server: http.Server | null = null;
  private port = 0;
  private onNotify: NotifyHandler;
  private logger: Logger;

  constructor(logger: Logger, onNotify: NotifyHandler) {
    this.logger = logger;
    this.onNotify = onNotify;
  }

  async start(): Promise<number> {
    const config = vscode.workspace.getConfiguration("agent-notify");
    const basePort = config.get<number>("port", 19876);

    this.server = http.createServer((req, res) =>
      this.handleRequest(req, res)
    );

    this.port = await this.bindPort(basePort);
    this.writePortFile();
    this.logger.info("server", "server_started", { port: this.port });
    return this.port;
  }

  private bindPort(basePort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const tryPort = (port: number, attempt: number) => {
        if (attempt > 10) {
          reject(new Error(`Could not bind to any port ${basePort}-${basePort + 10}`));
          return;
        }

        this.server!.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            this.logger.info("server", "port_busy", { port, attempt });
            // Check if it's another extension instance
            this.probeHealth(port)
              .then((isOurs) => {
                if (isOurs) {
                  // Another VS Code window owns this port — we're secondary
                  this.logger.info("server", "secondary_window", { port });
                  reject(new Error("SECONDARY"));
                } else {
                  tryPort(port + 1, attempt + 1);
                }
              })
              .catch(() => tryPort(port + 1, attempt + 1));
          } else {
            reject(err);
          }
        });

        this.server!.listen(port, "127.0.0.1", () => resolve(port));
      };

      tryPort(basePort, 0);
    });
  }

  private probeHealth(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/health", method: "GET", timeout: 2000 },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk.toString()));
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              resolve(data.status === "ok" && data.app === "agent-notify");
            } catch {
              resolve(false);
            }
          });
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Only accept from localhost
    const remoteAddr = req.socket.remoteAddress;
    if (remoteAddr !== "127.0.0.1" && remoteAddr !== "::1" && remoteAddr !== "::ffff:127.0.0.1") {
      res.writeHead(403);
      res.end("Forbidden");
      this.logger.warn("server", "rejected_non_local", { remoteAddr });
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", app: "agent-notify", port: this.port }));
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/notify")) {
      this.handleNotify(req, res);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  }

  private handleNotify(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url!, `http://localhost:${this.port}`);
    const source = url.searchParams.get("source") || "unknown";

    let body = "";
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PAYLOAD) {
        res.writeHead(413);
        res.end("Payload too large");
        req.destroy();
        this.logger.warn("server", "payload_too_large", { source, size });
        return;
      }
      body += chunk.toString();
    });

    req.on("end", () => {
      // Respond immediately
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');

      this.logger.info("server", "POST /notify", {
        source,
        payloadBytes: size,
        status: 200,
        remoteAddr: req.socket.remoteAddress,
      });

      // Parse and forward async
      try {
        const payload = JSON.parse(body);
        this.onNotify(source, payload);
      } catch (err) {
        this.logger.error("server", "invalid_json", {
          source,
          error: String(err),
        });
      }
    });
  }

  private writePortFile(): void {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(PORT_FILE, String(this.port));
    } catch (err) {
      this.logger.error("server", "write_port_file_failed", {
        error: String(err),
      });
    }
  }

  private removePortFile(): void {
    try {
      if (fs.existsSync(PORT_FILE)) {
        const stored = fs.readFileSync(PORT_FILE, "utf-8").trim();
        if (stored === String(this.port)) {
          fs.unlinkSync(PORT_FILE);
        }
      }
    } catch {
      // Best effort
    }
  }

  getPort(): number {
    return this.port;
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.removePortFile();
      this.logger.info("server", "server_stopped", { port: this.port });
    }
  }
}
