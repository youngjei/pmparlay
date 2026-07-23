export function canCommitWalletSyncAttempt(currentGeneration: number, attemptGeneration: number, aborted: boolean) {
  return !aborted && currentGeneration === attemptGeneration;
}
