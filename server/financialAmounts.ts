export function parseUsdcMicroUnitsExact(value: string | bigint) {
  if (typeof value === "bigint") {
    if (value <= 0n) throw new Error("invalid_withdrawal_amount");
    return value;
  }

  const amount = value.trim();
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(amount);
  if (!match) throw new Error("invalid_usdc_amount");
  const whole = BigInt(match[1]);
  const fractional = BigInt((match[2] || "").padEnd(6, "0"));
  const microUnits = whole * 1_000_000n + fractional;
  if (microUnits <= 0n) throw new Error("invalid_withdrawal_amount");
  return microUnits;
}

export function parseUsdcNumberExact(value: number) {
  if (!Number.isFinite(value)) throw new Error("invalid_usdc_amount");
  return parseUsdcMicroUnitsExact(value.toString());
}
