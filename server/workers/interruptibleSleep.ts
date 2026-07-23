export function createInterruptibleSleeper() {
  let interruptCurrent: (() => void) | undefined;

  return {
    sleep(ms: number) {
      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (interruptCurrent === finish) interruptCurrent = undefined;
          resolve();
        };
        const timer = setTimeout(finish, ms);
        interruptCurrent = finish;
      });
    },
    interrupt() {
      interruptCurrent?.();
    }
  };
}
