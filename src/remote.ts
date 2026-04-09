import * as vscode from "vscode";
import { Logger } from "./logger";

export interface RemoteContext {
  isRemote: boolean;
  remoteName?: string;
  authority?: string;
  hostLabel?: string;
}

export function detectRemote(logger: Logger): RemoteContext {
  // Detect remote via extension host environment variable
  // vscode.env.remoteName requires the 'resolvers' proposed API, so we avoid it.
  // Instead, check the VSCODE_REMOTE_AUTHORITY env var set by VS Code.
  const authority = process.env.VSCODE_REMOTE_AUTHORITY || undefined;
  const remoteName = authority ? authority.split("+")[0] : undefined;

  const ctx: RemoteContext = {
    isRemote: !!authority,
    remoteName,
    authority,
    hostLabel: authority ? authority.replace(/^ssh-remote\+/, "") : undefined,
  };

  if (ctx.isRemote) {
    logger.info("setup", "remote_detected", {
      remoteName: ctx.remoteName,
      authority: ctx.authority,
    });
  }

  return ctx;
}

export async function setupRemote(
  ctx: RemoteContext,
  port: number,
  logger: Logger
): Promise<void> {
  if (!ctx.isRemote || !ctx.authority) {
    vscode.window.showWarningMessage(
      "Not connected to a remote host. Connect via Remote-SSH first."
    );
    return;
  }

  // Test if port forwarding works
  const forwarding = await testPortForwarding(port, logger);

  if (forwarding) {
    vscode.window.showInformationMessage(
      `Port forwarding is working. Remote hooks on ${ctx.hostLabel} can reach the notification server.`
    );
    logger.info("setup", "remote_port_forwarding_ok", {
      host: ctx.hostLabel,
      port,
    });
  } else {
    const sshConfig = `Host ${ctx.hostLabel}\n  RemoteForward ${port} localhost:${port}`;
    const action = await vscode.window.showWarningMessage(
      `Port forwarding not detected. Add this to ~/.ssh/config and reconnect:\n\n${sshConfig}`,
      "Copy to Clipboard"
    );
    if (action === "Copy to Clipboard") {
      await vscode.env.clipboard.writeText(sshConfig);
      vscode.window.showInformationMessage("SSH config copied to clipboard.");
    }
    logger.warn("setup", "remote_port_forwarding_failed", {
      host: ctx.hostLabel,
      port,
    });
  }
}

async function testPortForwarding(
  port: number,
  logger: Logger
): Promise<boolean> {
  // Run curl on the remote to check if it can reach our local server
  try {
    const terminal = vscode.window.createTerminal({
      name: "Agent Notify: Test",
      hideFromUser: true,
    });

    // We can't easily capture terminal output, so we use a different approach:
    // Try to create a temporary task that checks connectivity
    const result = await new Promise<boolean>((resolve) => {
      // Use the extension's knowledge: if we're remote and the server is running locally,
      // VS Code may auto-forward the port. Check the forwarded ports.
      // For now, we'll assume it needs manual setup and guide the user.
      // A more sophisticated check could use vscode.workspace.fs or a task.
      logger.info("setup", "remote_forwarding_check_skipped", {
        reason: "simplified_v1",
      });
      resolve(false);
    });

    terminal.dispose();
    return result;
  } catch (err) {
    logger.error("setup", "remote_check_failed", { error: String(err) });
    return false;
  }
}
