import { networkInterfaces } from 'node:os';

/** Prefer a private LAN v4 address so the URL works from an iPad on the same Wi-Fi. */
export function lanAddress(): string {
  const nets = networkInterfaces();
  const candidates: { address: string; score: number }[] = [];

  for (const [name, infos] of Object.entries(nets)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      candidates.push({ address: info.address, score: score(name, info.address) });
    }
  }

  if (candidates.length === 0) return '127.0.0.1';
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.address;
}

function score(name: string, address: string): number {
  let s = 0;
  // Real Wi-Fi/Ethernet adapters beat virtual ones (Hyper-V, WSL, VPN, Docker).
  if (/wi-?fi|wlan|ethernet/i.test(name)) s += 40;
  if (/vethernet|hyper-v|vmware|virtualbox|docker|tailscale|zerotier|wsl|loopback/i.test(name)) s -= 50;
  if (/^192\.168\./.test(address)) s += 30;
  if (/^10\./.test(address)) s += 20;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) s += 10;
  if (/^169\.254\./.test(address)) s -= 40;
  return s;
}
