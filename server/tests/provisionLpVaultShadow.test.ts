import { describe, expect, it } from "vitest";
import { shadowVaultProvisioningInput } from "../provisionLpVaultShadow";

const treasuryAddress = "0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B";
const tokenAddress = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

describe("LP Vault shadow provisioning", () => {
  it("pins the idempotent provisioner to the approved Sepolia house-book scope", () => {
    expect(shadowVaultProvisioningInput({
      accountingMode: "house_book_usdc",
      chainId: 11155111,
      treasuryAddress,
      tokenAddress
    })).toEqual({ treasuryAddress, tokenAddress });
  });

  it.each([
    [{ accountingMode: "play_money", chainId: 11155111, treasuryAddress, tokenAddress }, "shadow_vault_requires_house_book_usdc"],
    [{ accountingMode: "house_book_usdc", chainId: 1, treasuryAddress, tokenAddress }, "shadow_vault_requires_sepolia"],
    [{ accountingMode: "house_book_usdc", chainId: 11155111, treasuryAddress: undefined, tokenAddress }, "shadow_vault_treasury_required"],
    [{ accountingMode: "house_book_usdc", chainId: 11155111, treasuryAddress, tokenAddress: treasuryAddress }, "shadow_vault_requires_circle_sepolia_usdc"]
  ])("rejects an unsafe deployment scope", (input, message) => {
    expect(() => shadowVaultProvisioningInput(input)).toThrow(message);
  });
});
