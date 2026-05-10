// Shared Nano currency utilities for RaiFlow examples

const RAW_PER_XNO = 1_000_000_000_000_000_000_000_000_000n; // 10^30

export function xnoToRaw(xno) {
  const s = String(xno).trim();
  const dot = s.indexOf('.');
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracPart = dot === -1 ? '' : s.slice(dot + 1);
  const padded = (fracPart + '0'.repeat(30)).slice(0, 30);
  return (BigInt(intPart) * RAW_PER_XNO + BigInt(padded)).toString();
}

export function xnoDisplay(raw) {
  if (!raw) return '0';
  const n = BigInt(raw);
  const intPart = n / RAW_PER_XNO;
  const fracPart = (n % RAW_PER_XNO).toString().padStart(30, '0').replace(/0+$/, '');
  if (fracPart === '') return intPart.toString();
  return `${intPart}.${fracPart}`.replace(/\.$/, '');
}

function truncateAddress(addr) {
  if (!addr || addr.length < 20) return addr ?? '?';
  return addr.slice(0, 13) + '…' + addr.slice(-6);
}
