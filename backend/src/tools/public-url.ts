import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { badRequest } from '../shared/app-error.js';

export type ResolvedAddress = { address: string; family: number };
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type ValidatedPublicTarget = { url: URL; addresses: ResolvedAddress[] };

const systemResolver: HostResolver = hostname => lookup(hostname, { all: true, verbatim: true });
const blockedIpv4Ranges: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function ipv4Number(address: string): bigint | undefined {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return undefined;
  return octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function inIpv4Range(address: string, network: string, prefix: number): boolean {
  const value = ipv4Number(address); const base = ipv4Number(network);
  return value !== undefined && base !== undefined && (value >> BigInt(32 - prefix)) === (base >> BigInt(32 - prefix));
}

function ipv6Number(input: string): bigint | undefined {
  let address = input.toLowerCase().split('%')[0]!;
  if (address.includes('.')) {
    const separator = address.lastIndexOf(':');
    const tail = ipv4Number(address.slice(separator + 1));
    if (tail === undefined) return undefined;
    const high = Number(tail >> 16n).toString(16); const low = Number(tail & 0xffffn).toString(16);
    address = `${address.slice(0, separator)}:${high}:${low}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0]!.split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function inIpv6Range(value: bigint, network: bigint, prefix: number): boolean {
  return (value >> BigInt(128 - prefix)) === (network >> BigInt(128 - prefix));
}

function isNonPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return blockedIpv4Ranges.some(([network, prefix]) => inIpv4Range(address, network, prefix));
  if (version !== 6) return true;
  const value = ipv6Number(address);
  if (value === undefined) return true;
  if (value >> 32n === 0xffffn) {
    const mappedIpv4 = [24n, 16n, 8n, 0n].map(shift => Number((value >> shift) & 0xffn)).join('.');
    return isNonPublicAddress(mappedIpv4);
  }
  const globalUnicast = inIpv6Range(value, 0x20000000000000000000000000000000n, 3);
  const specialUse = inIpv6Range(value, 0x20010000000000000000000000000000n, 23)
    || inIpv6Range(value, 0x20010db8000000000000000000000000n, 32)
    || inIpv6Range(value, 0x20020000000000000000000000000000n, 16)
    || inIpv6Range(value, 0x3fff0000000000000000000000000000n, 20);
  return !globalUnicast || specialUse;
}

export async function resolvePublicHttpTarget(value: string, resolveHost: HostResolver = systemResolver): Promise<ValidatedPublicTarget> {
  let url: URL;
  try { url = new URL(value); } catch { throw badRequest('invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw badRequest('only public http(s) URLs are allowed');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || ['.localhost', '.local', '.internal', '.test', '.invalid', '.example'].some(suffix => hostname.endsWith(suffix)) || !hostname.includes('.') && isIP(hostname) === 0) throw badRequest('private or local network URLs are blocked');
  let addresses: ResolvedAddress[];
  if (isIP(hostname)) {
    if (isNonPublicAddress(hostname)) throw badRequest('private or local network URLs are blocked');
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try { addresses = await resolveHost(hostname); } catch { throw badRequest('URL host could not be resolved'); }
    if (!addresses.length || addresses.some(({ address }) => isNonPublicAddress(address))) throw badRequest('private or local network URLs are blocked');
  }
  if (url.port && !['80', '443'].includes(url.port)) throw badRequest('only HTTP(S) ports 80 and 443 are allowed');
  return { url, addresses };
}

export async function assertPublicHttpUrl(value: string, resolveHost: HostResolver = systemResolver): Promise<URL> {
  return (await resolvePublicHttpTarget(value, resolveHost)).url;
}
