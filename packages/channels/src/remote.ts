export interface RemoteTunnelDetection {
  readonly tailscale: string | null;
  readonly cloudflared: string | null;
}

export function detectRemoteTunnelTools(): RemoteTunnelDetection {
  return {
    tailscale: Bun.which('tailscale') ?? null,
    cloudflared: Bun.which('cloudflared') ?? null,
  };
}

export function buildTailscaleServeCommand(port = 4321, host = '127.0.0.1'): string {
  return `tailscale serve --bg http://${host}:${port}`;
}

export function buildCloudflaredCommand(port = 4321, host = '127.0.0.1'): string {
  return `cloudflared tunnel --url http://${host}:${port}`;
}
