// Shared Nano currency utilities for RaiFlow examples

export const RAW_PER_XNO = 10n ** 30n;

export function xnoToRaw(xno) {
  const s = String(xno).trim();
  const match = /^(\d+)(?:\.(\d{1,30}))?$/.exec(s);
  if (!match) throw new Error('Amount must be a decimal XNO value with up to 30 fractional digits');
  const integer = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(30, '0') || '0');
  const raw = integer * RAW_PER_XNO + fraction;
  if (raw <= 0n) throw new Error('Amount must be greater than zero');
  return raw.toString();
}

export function xnoDisplay(raw) {
  if (!raw) return '0';
  const n = BigInt(raw);
  const intPart = n / RAW_PER_XNO;
  const fracPart = (n % RAW_PER_XNO).toString().padStart(30, '0').replace(/0+$/, '');
  if (fracPart === '') return intPart.toString();
  return `${intPart}.${fracPart}`.replace(/\.$/, '');
}

export function truncateAddress(addr) {
  if (!addr || addr.length < 20) return addr ?? '?';
  return addr.slice(0, 13) + '…' + addr.slice(-6);
}
