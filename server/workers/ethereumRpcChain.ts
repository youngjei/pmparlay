type EthereumChainIdReader = () => Promise<unknown>;

export async function requireEthereumRpcChainId(readChainId: EthereumChainIdReader, expectedChainId: number) {
  const responseChainId = await readChainId();
  if (typeof responseChainId !== "string") {
    throw new Error("ethereum_rpc_chain_id_invalid");
  }
  let actualChainId: bigint;
  try {
    actualChainId = BigInt(responseChainId);
  } catch {
    throw new Error("ethereum_rpc_chain_id_invalid");
  }

  if (actualChainId !== BigInt(expectedChainId)) {
    throw new Error("ethereum_rpc_chain_id_mismatch");
  }
}
